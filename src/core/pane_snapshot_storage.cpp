#include "core/pane_snapshot_storage.hpp"

#include "lemma/limits.hpp"

#include <sodium/core.h>
#include <sodium/crypto_secretstream_xchacha20poly1305.h>
#include <sodium/utils.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <memory>
#include <new>
#include <span>
#include <string_view>
#include <type_traits>
#include <utility>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef LEMMA_GHOSTTY_PINNED_COMMIT
#error "LEMMA_GHOSTTY_PINNED_COMMIT must be configured"
#endif
#ifndef LEMMA_GHOSTTY_PINNED_PROFILE
#error "LEMMA_GHOSTTY_PINNED_PROFILE must be configured"
#endif

namespace lemma::core {
namespace {

constexpr std::string_view storage_magic = "LEMPARK2";
constexpr std::size_t header_bytes = 96;
constexpr std::size_t chunk_bytes = std::size_t{64} * 1'024U;
constexpr std::size_t tag_bytes = crypto_secretstream_xchacha20poly1305_ABYTES;
constexpr std::size_t stream_header_bytes = crypto_secretstream_xchacha20poly1305_HEADERBYTES;
constexpr std::string_view filename_suffix = "/.lemma-pane-snapshot-XXXXXX";
using StreamState = crypto_secretstream_xchacha20poly1305_state;

struct SecretData final {
  std::array<unsigned char, crypto_secretstream_xchacha20poly1305_KEYBYTES> key;
  StreamState state;
};

struct ClearStream final {
  void operator()(StreamState* const state) const noexcept {
    sodium_memzero(state, sizeof(*state));
  }
};

[[nodiscard]] constexpr auto chunk_tag(const bool final) noexcept -> unsigned char {
  return final ? crypto_secretstream_xchacha20poly1305_TAG_FINAL
               : crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
}

template <typename Byte>
[[nodiscard]] auto sodium_bytes(const std::span<Byte> bytes) noexcept
    -> std::conditional_t<std::is_const_v<Byte>, const unsigned char*, unsigned char*> {
  // libsodium's byte-oriented C API uses unsigned char rather than std::byte.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return reinterpret_cast<
      std::conditional_t<std::is_const_v<Byte>, const unsigned char*, unsigned char*>>(
      bytes.data());
}

template <typename Integer>
void write_little_endian(const std::span<std::byte> destination, const std::size_t offset,
                         const Integer value) noexcept {
  for (std::size_t index = 0; index < sizeof(Integer); ++index) {
    destination.subspan(offset + index, 1U).front() =
        static_cast<std::byte>((value >> (index * 8U)) & Integer{0xFF});
  }
}

[[nodiscard]] auto valid_metadata(const PaneSnapshotMetadata& metadata) noexcept -> bool {
  const auto compatibility = metadata.compatibility;
  const auto geometry = metadata.geometry;
  return geometry.columns > 0 && geometry.rows > 0 &&
         geometry.columns <= limits::terminal_columns_hard_max &&
         geometry.rows <= limits::terminal_rows_hard_max &&
         compatibility.ghostty_commit.size() == 40 &&
         std::ranges::all_of(compatibility.ghostty_commit,
                             [](const char character) {
                               return (character >= '0' && character <= '9') ||
                                      (character >= 'a' && character <= 'f');
                             }) &&
         !compatibility.ghostty_profile.empty() && compatibility.ghostty_profile.size() <= 16;
}

void encode_header(const std::span<std::byte> header, const PaneSnapshotMetadata& metadata,
                   const std::size_t payload_bytes) noexcept {
  std::ranges::fill(header, std::byte{0});
  std::memcpy(header.data(), storage_magic.data(), storage_magic.size());
  write_little_endian(header, 8, std::uint16_t{2});
  write_little_endian(header, 10, static_cast<std::uint16_t>(header_bytes));
  write_little_endian(header, 12, metadata.geometry.columns);
  write_little_endian(header, 14, metadata.geometry.rows);
  write_little_endian(header, 16, metadata.geometry.cell_width_px);
  write_little_endian(header, 20, metadata.geometry.cell_height_px);
  write_little_endian(header, 24, static_cast<std::uint64_t>(payload_bytes));
  std::memcpy(header.subspan(40).data(), metadata.compatibility.ghostty_commit.data(), 40);
  std::memcpy(header.subspan(80).data(), metadata.compatibility.ghostty_profile.data(),
              metadata.compatibility.ghostty_profile.size());
}

[[nodiscard]] constexpr auto stored_bytes(const std::size_t payload_bytes) noexcept -> std::size_t {
  return header_bytes + stream_header_bytes + payload_bytes +
         (((payload_bytes + chunk_bytes - 1U) / chunk_bytes) * tag_bytes);
}

[[nodiscard]] auto write_exact(const int descriptor, std::span<const std::byte> bytes,
                               std::size_t offset) noexcept -> bool {
  while (!bytes.empty()) {
    const auto written =
        ::pwrite(descriptor, bytes.data(), bytes.size(), static_cast<off_t>(offset));
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written <= 0) {
      return false;
    }
    const auto count = static_cast<std::size_t>(written);
    bytes = bytes.subspan(count);
    offset += count;
  }
  return true;
}

[[nodiscard]] auto read_exact(const int descriptor, std::span<std::byte> bytes,
                              std::size_t offset) noexcept -> bool {
  while (!bytes.empty()) {
    const auto received =
        ::pread(descriptor, bytes.data(), bytes.size(), static_cast<off_t>(offset));
    if (received < 0 && errno == EINTR) {
      continue;
    }
    if (received <= 0) {
      return false;
    }
    const auto count = static_cast<std::size_t>(received);
    bytes = bytes.subspan(count);
    offset += count;
  }
  return true;
}

[[nodiscard]] auto create_file(const std::string_view directory) noexcept
    -> std::expected<int, PaneSnapshotStorageError> {
  std::array<char, 4'096> path{};
  if (directory.empty() || directory.size() + filename_suffix.size() >= path.size()) {
    return std::unexpected(PaneSnapshotStorageError::invalid_options);
  }
  std::ranges::copy(directory, path.begin());
  std::ranges::copy(filename_suffix, std::span(path).subspan(directory.size()).begin());
  const int descriptor = ::mkstemp(path.data());
  if (descriptor < 0) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  // fcntl is a POSIX variadic API; these commands use its specified zero/int argument forms.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const int flags = ::fcntl(descriptor, F_GETFD);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const bool configured = flags >= 0 && ::fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0 &&
                          ::fchmod(descriptor, S_IRUSR | S_IWUSR) == 0;
  const bool unlinked = ::unlink(path.data()) == 0;
  if (!configured || !unlinked) {
    static_cast<void>(::close(descriptor));
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  return descriptor;
}

} // namespace

// The only retained secret is in explicitly locked, guarded libsodium storage. Failure to lock is
// an admission failure, never a silent downgrade to swappable keys. Stream state shares the lock
// during encryption/decryption and is wiped after each operation, including every error path.
struct PaneSnapshotSecret final {
  explicit PaneSnapshotSecret(SecretData* value) noexcept : data(value) {}
  PaneSnapshotSecret(PaneSnapshotSecret&&) = delete;
  auto operator=(PaneSnapshotSecret&&) -> PaneSnapshotSecret& = delete;
  PaneSnapshotSecret(const PaneSnapshotSecret&) = delete;
  auto operator=(const PaneSnapshotSecret&) -> PaneSnapshotSecret& = delete;
  ~PaneSnapshotSecret() { sodium_free(data); }

  [[nodiscard]] static auto create() noexcept -> std::unique_ptr<PaneSnapshotSecret> {
    if (sodium_init() < 0) {
      return {};
    }
    void* const memory = sodium_malloc(sizeof(SecretData));
    if (memory == nullptr) {
      return {};
    }
    if (sodium_mlock(memory, sizeof(SecretData)) != 0) {
      sodium_free(memory);
      return {};
    }
    auto* const data = new (memory) SecretData{};
    std::unique_ptr<PaneSnapshotSecret> secret(new (std::nothrow) PaneSnapshotSecret(data));
    if (secret == nullptr) {
      sodium_free(memory);
      return {};
    }
    crypto_secretstream_xchacha20poly1305_keygen(data->key.data());
    return secret;
  }

  SecretData* data;
};

auto current_pane_snapshot_compatibility() noexcept -> PaneSnapshotCompatibility {
  return {.ghostty_commit = LEMMA_GHOSTTY_PINNED_COMMIT,
          .ghostty_profile = LEMMA_GHOSTTY_PINNED_PROFILE};
}

PaneSnapshotPlaintext::PaneSnapshotPlaintext(void* const mapping, const std::size_t size) noexcept
    : mapping_(mapping), size_(size) {}
PaneSnapshotPlaintext::PaneSnapshotPlaintext(PaneSnapshotPlaintext&& other) noexcept
    : mapping_(std::exchange(other.mapping_, nullptr)), size_(std::exchange(other.size_, 0)) {}
PaneSnapshotPlaintext::~PaneSnapshotPlaintext() { reset(); }
void PaneSnapshotPlaintext::reset() noexcept {
  if (mapping_ != nullptr) {
    sodium_memzero(mapping_, size_);
    static_cast<void>(::munmap(mapping_, size_));
    mapping_ = nullptr;
    size_ = 0;
  }
}

auto PaneSnapshotPlaintext::create(const std::size_t size) noexcept
    -> std::expected<PaneSnapshotPlaintext, PaneSnapshotStorageError> {
  void* const mapping =
      ::mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (mapping == MAP_FAILED) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  return PaneSnapshotPlaintext(mapping, size);
}
auto PaneSnapshotPlaintext::bytes() const noexcept -> std::span<const std::byte> {
  return {static_cast<const std::byte*>(mapping_), size_};
}
auto PaneSnapshotPlaintext::writable_bytes() noexcept -> std::span<std::byte> {
  return {static_cast<std::byte*>(mapping_), size_};
}

PaneSnapshot::PaneSnapshot() noexcept = default;
PaneSnapshot::PaneSnapshot(const int descriptor, const std::size_t payload_size,
                           std::unique_ptr<PaneSnapshotSecret> secret) noexcept
    : descriptor_(descriptor), payload_bytes_(payload_size), secret_(std::move(secret)) {}
PaneSnapshot::PaneSnapshot(PaneSnapshot&& other) noexcept
    : descriptor_(std::exchange(other.descriptor_, -1)),
      payload_bytes_(std::exchange(other.payload_bytes_, 0)), secret_(std::move(other.secret_)) {}
auto PaneSnapshot::operator=(PaneSnapshot&& other) noexcept -> PaneSnapshot& {
  if (this != &other) {
    reset();
    descriptor_ = std::exchange(other.descriptor_, -1);
    payload_bytes_ = std::exchange(other.payload_bytes_, 0);
    secret_ = std::move(other.secret_);
  }
  return *this;
}
PaneSnapshot::~PaneSnapshot() { reset(); }
void PaneSnapshot::reset() noexcept {
  if (descriptor_ >= 0) {
    static_cast<void>(::close(descriptor_));
    descriptor_ = -1;
  }
  payload_bytes_ = 0;
  secret_.reset();
}

auto PaneSnapshot::payload(const PaneSnapshotMetadata& expected) const noexcept
    -> std::expected<PaneSnapshotPlaintext, PaneSnapshotStorageError> {
  if (!valid() || !valid_metadata(expected)) {
    return std::unexpected(PaneSnapshotStorageError::invalid_options);
  }
  struct stat status{};
  if (::fstat(descriptor_, &status) != 0) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  if (std::cmp_not_equal(status.st_size, stored_bytes(payload_bytes_))) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  std::array<std::byte, header_bytes> header{};
  std::array<std::byte, header_bytes> expected_header{};
  std::array<unsigned char, stream_header_bytes> stream_header{};
  if (!read_exact(descriptor_, header, 0) ||
      !read_exact(descriptor_, std::as_writable_bytes(std::span(stream_header)), header_bytes)) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  encode_header(expected_header, expected, payload_bytes_);
  if (header != expected_header) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  auto& state = secret_->data->state;
  const std::unique_ptr<StreamState, ClearStream> clear(&state);
  if (crypto_secretstream_xchacha20poly1305_init_pull(&state, stream_header.data(),
                                                      secret_->data->key.data()) != 0) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  auto plaintext = PaneSnapshotPlaintext::create(payload_bytes_);
  if (!plaintext.has_value()) {
    return std::unexpected(plaintext.error());
  }
  auto remaining = plaintext->writable_bytes();
  std::array<std::byte, chunk_bytes + tag_bytes> ciphertext{};
  std::size_t offset = header_bytes + stream_header_bytes;
  while (!remaining.empty()) {
    const auto count = std::min(remaining.size(), chunk_bytes);
    auto encoded = std::span(ciphertext).first(count + tag_bytes);
    if (!read_exact(descriptor_, encoded, offset)) {
      return std::unexpected(PaneSnapshotStorageError::io_error);
    }
    unsigned char tag = 0;
    const auto expected_tag = chunk_tag(count == remaining.size());
    if (crypto_secretstream_xchacha20poly1305_pull(
            &state, sodium_bytes(remaining.first(count)), nullptr, &tag, sodium_bytes(encoded),
            encoded.size(), sodium_bytes(std::span<const std::byte>(header)), header.size()) != 0 ||
        tag != expected_tag) {
      return std::unexpected(PaneSnapshotStorageError::invalid_state);
    }
    remaining = remaining.subspan(count);
    offset += encoded.size();
  }
  return plaintext;
}

auto PaneSnapshot::payload_bytes() const noexcept -> std::size_t { return payload_bytes_; }
auto PaneSnapshot::valid() const noexcept -> bool {
  return descriptor_ >= 0 && secret_ != nullptr && payload_bytes_ > 0 &&
         payload_bytes_ <= limits::snapshot_bytes_max;
}

WritablePaneSnapshot::WritablePaneSnapshot(const int descriptor, PaneSnapshotPlaintext plaintext,
                                           std::unique_ptr<PaneSnapshotSecret> secret) noexcept
    : descriptor_(descriptor), plaintext_(std::move(plaintext)), secret_(std::move(secret)) {}
WritablePaneSnapshot::WritablePaneSnapshot(WritablePaneSnapshot&& other) noexcept
    : descriptor_(std::exchange(other.descriptor_, -1)), plaintext_(std::move(other.plaintext_)),
      secret_(std::move(other.secret_)) {}
WritablePaneSnapshot::~WritablePaneSnapshot() {
  if (descriptor_ >= 0) {
    static_cast<void>(::close(descriptor_));
  }
}

auto WritablePaneSnapshot::create(const PaneSnapshotMetadata& metadata,
                                  const std::size_t payload_bytes,
                                  const std::string_view directory) noexcept
    -> std::expected<WritablePaneSnapshot, PaneSnapshotStorageError> {
  if (!valid_metadata(metadata)) {
    return std::unexpected(PaneSnapshotStorageError::invalid_options);
  }
  if (payload_bytes == 0) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  if (payload_bytes > limits::snapshot_bytes_max) {
    return std::unexpected(PaneSnapshotStorageError::limit_exceeded);
  }
  auto plaintext = PaneSnapshotPlaintext::create(header_bytes + payload_bytes);
  auto secret = PaneSnapshotSecret::create();
  if (!plaintext.has_value() || secret == nullptr) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  auto descriptor = create_file(directory);
  if (!descriptor.has_value()) {
    return std::unexpected(descriptor.error());
  }
  encode_header(plaintext->writable_bytes().first(header_bytes), metadata, payload_bytes);
  return WritablePaneSnapshot(*descriptor, std::move(*plaintext), std::move(secret));
}

auto WritablePaneSnapshot::payload() noexcept -> std::span<std::byte> {
  auto bytes = plaintext_.writable_bytes();
  return bytes.size() > header_bytes ? bytes.subspan(header_bytes) : std::span<std::byte>{};
}
auto WritablePaneSnapshot::payload_bytes() const noexcept -> std::size_t {
  const auto size = plaintext_.bytes().size();
  return size > header_bytes ? size - header_bytes : 0;
}

auto WritablePaneSnapshot::finish() && noexcept
    -> std::expected<PaneSnapshot, PaneSnapshotStorageError> {
  if (descriptor_ < 0 || secret_ == nullptr || payload_bytes() == 0) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  const auto header = plaintext_.bytes().first(header_bytes);
  auto remaining = plaintext_.bytes().subspan(header_bytes);
  auto& state = secret_->data->state;
  const std::unique_ptr<StreamState, ClearStream> clear(&state);
  std::array<unsigned char, stream_header_bytes> stream_header{};
  if (crypto_secretstream_xchacha20poly1305_init_push(&state, stream_header.data(),
                                                      secret_->data->key.data()) != 0 ||
      !write_exact(descriptor_, header, 0) ||
      !write_exact(descriptor_, std::as_bytes(std::span(stream_header)), header_bytes)) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  std::array<std::byte, chunk_bytes + tag_bytes> ciphertext{};
  std::size_t offset = header_bytes + stream_header_bytes;
  while (!remaining.empty()) {
    const auto count = std::min(remaining.size(), chunk_bytes);
    const auto encoded = std::span(ciphertext).first(count + tag_bytes);
    const auto tag = chunk_tag(count == remaining.size());
    if (crypto_secretstream_xchacha20poly1305_push(
            &state, sodium_bytes(encoded), nullptr, sodium_bytes(remaining.first(count)), count,
            sodium_bytes(header), header.size(), static_cast<unsigned char>(tag)) != 0 ||
        !write_exact(descriptor_, encoded, offset)) {
      return std::unexpected(PaneSnapshotStorageError::io_error);
    }
    remaining = remaining.subspan(count);
    offset += encoded.size();
  }
  // Ephemeral encrypted backing does not promise crash durability. pwrite reports allocation/I/O
  // failures without MAP_SHARED write faults; neither msync nor fsync belongs in this transition.
  // Dirty ciphertext remains charged to the kernel cache until normal writeback/reclamation.
  const auto size = payload_bytes();
  plaintext_.reset();
  return PaneSnapshot(std::exchange(descriptor_, -1), size, std::move(secret_));
}

} // namespace lemma::core
