#include "core/pane_snapshot_storage.hpp"

#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <limits>
#include <span>
#include <string_view>
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

constexpr std::string_view storage_magic = "LEMPARK1";
constexpr std::uint16_t storage_schema = 1;
constexpr std::size_t commit_bytes = 40;
constexpr std::size_t profile_bytes = 16;
constexpr std::size_t header_bytes = 96;
constexpr std::size_t schema_offset = 8;
constexpr std::size_t header_size_offset = 10;
constexpr std::size_t columns_offset = 12;
constexpr std::size_t rows_offset = 14;
constexpr std::size_t cell_width_offset = 16;
constexpr std::size_t cell_height_offset = 20;
constexpr std::size_t payload_size_offset = 24;
constexpr std::size_t payload_hash_offset = 32;
constexpr std::size_t commit_offset = 40;
constexpr std::size_t profile_offset = 80;
constexpr std::string_view filename_suffix = "/.lemma-pane-snapshot-XXXXXX";

static_assert(storage_magic.size() == schema_offset);
static_assert(commit_offset + commit_bytes == profile_offset);
static_assert(profile_offset + profile_bytes == header_bytes);
static_assert(limits::snapshot_bytes_max <=
              static_cast<std::size_t>(std::numeric_limits<off_t>::max()) - header_bytes);

template <typename Integer>
void write_little_endian(const std::span<std::byte> destination, const std::size_t offset,
                         const Integer value) noexcept {
  for (std::size_t index = 0; index < sizeof(Integer); ++index) {
    destination.subspan(offset + index, 1U).front() =
        static_cast<std::byte>((value >> (index * 8U)) & Integer{0xFF});
  }
}

template <typename Integer>
[[nodiscard]] auto read_little_endian(const std::span<const std::byte> source,
                                      const std::size_t offset) noexcept -> Integer {
  Integer value{0};
  for (std::size_t index = 0; index < sizeof(Integer); ++index) {
    value |= std::to_integer<Integer>(source.subspan(offset + index, 1U).front()) << (index * 8U);
  }
  return value;
}

[[nodiscard]] constexpr auto valid_geometry(const vt::TerminalSize geometry) noexcept -> bool {
  return geometry.columns > 0 && geometry.rows > 0 &&
         geometry.columns <= limits::terminal_columns_hard_max &&
         geometry.rows <= limits::terminal_rows_hard_max;
}

[[nodiscard]] auto snapshot_payload_hash(const std::span<const std::byte> payload) noexcept
    -> std::uint64_t {
  constexpr std::uint64_t offset_basis = 14'695'981'039'346'656'037ULL;
  constexpr std::uint64_t prime = 1'099'511'628'211ULL;
  auto hash = offset_basis;
  for (const auto value : payload) {
    hash ^= std::to_integer<std::uint8_t>(value);
    hash *= prime;
  }
  return hash;
}

[[nodiscard]] auto valid_compatibility(const PaneSnapshotCompatibility compatibility) noexcept
    -> bool {
  const auto commit_character = [](const char character) noexcept {
    return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
  };
  return compatibility.ghostty_commit.size() == commit_bytes &&
         std::ranges::all_of(compatibility.ghostty_commit, commit_character) &&
         !compatibility.ghostty_profile.empty() &&
         compatibility.ghostty_profile.size() <= profile_bytes;
}

[[nodiscard]] auto valid_metadata(const PaneSnapshotMetadata& metadata) noexcept -> bool {
  return valid_compatibility(metadata.compatibility) && valid_geometry(metadata.geometry);
}

void encode_header(const std::span<std::byte> mapping, const PaneSnapshotMetadata& metadata,
                   const std::size_t payload_bytes) noexcept {
  std::memcpy(mapping.data(), storage_magic.data(), storage_magic.size());
  write_little_endian(mapping, schema_offset, storage_schema);
  write_little_endian(mapping, header_size_offset, static_cast<std::uint16_t>(header_bytes));
  write_little_endian(mapping, columns_offset, metadata.geometry.columns);
  write_little_endian(mapping, rows_offset, metadata.geometry.rows);
  write_little_endian(mapping, cell_width_offset, metadata.geometry.cell_width_px);
  write_little_endian(mapping, cell_height_offset, metadata.geometry.cell_height_px);
  write_little_endian(mapping, payload_size_offset, static_cast<std::uint64_t>(payload_bytes));
  write_little_endian(mapping, payload_hash_offset, std::uint64_t{0});
  std::memcpy(mapping.subspan(commit_offset, commit_bytes).data(),
              metadata.compatibility.ghostty_commit.data(), commit_bytes);
  auto profile = mapping.subspan(profile_offset, profile_bytes);
  std::ranges::fill(profile, std::byte{0});
  std::memcpy(profile.data(), metadata.compatibility.ghostty_profile.data(),
              metadata.compatibility.ghostty_profile.size());
}

[[nodiscard]] auto header_matches(const std::span<const std::byte> mapping,
                                  const PaneSnapshotMetadata& expected,
                                  const std::size_t payload_bytes) noexcept -> bool {
  if (mapping.size() != header_bytes + payload_bytes ||
      std::memcmp(mapping.data(), storage_magic.data(), storage_magic.size()) != 0 ||
      read_little_endian<std::uint16_t>(mapping, schema_offset) != storage_schema ||
      read_little_endian<std::uint16_t>(mapping, header_size_offset) != header_bytes ||
      read_little_endian<std::uint16_t>(mapping, columns_offset) != expected.geometry.columns ||
      read_little_endian<std::uint16_t>(mapping, rows_offset) != expected.geometry.rows ||
      read_little_endian<std::uint32_t>(mapping, cell_width_offset) !=
          expected.geometry.cell_width_px ||
      read_little_endian<std::uint32_t>(mapping, cell_height_offset) !=
          expected.geometry.cell_height_px ||
      read_little_endian<std::uint64_t>(mapping, payload_size_offset) != payload_bytes ||
      read_little_endian<std::uint64_t>(mapping, payload_hash_offset) !=
          snapshot_payload_hash(mapping.subspan(header_bytes, payload_bytes)) ||
      std::memcmp(mapping.subspan(commit_offset, commit_bytes).data(),
                  expected.compatibility.ghostty_commit.data(), commit_bytes) != 0 ||
      std::memcmp(
          mapping.subspan(profile_offset, expected.compatibility.ghostty_profile.size()).data(),
          expected.compatibility.ghostty_profile.data(),
          expected.compatibility.ghostty_profile.size()) != 0) {
    return false;
  }
  return std::ranges::all_of(
      mapping.subspan(profile_offset + expected.compatibility.ghostty_profile.size(),
                      profile_bytes - expected.compatibility.ghostty_profile.size()),
      [](const std::byte value) noexcept { return value == std::byte{0}; });
}

void release_mapping(int& descriptor, void*& mapping, std::size_t& mapping_bytes) noexcept {
  if (mapping != nullptr) {
    static_cast<void>(::munmap(mapping, mapping_bytes));
    mapping = nullptr;
  }
  if (descriptor >= 0) {
    static_cast<void>(::close(descriptor));
    descriptor = -1;
  }
  mapping_bytes = 0;
}

} // namespace

auto current_pane_snapshot_compatibility() noexcept -> PaneSnapshotCompatibility {
  return {
      .ghostty_commit = LEMMA_GHOSTTY_PINNED_COMMIT,
      .ghostty_profile = LEMMA_GHOSTTY_PINNED_PROFILE,
  };
}

PaneSnapshot::PaneSnapshot(void* const mapping, const std::size_t mapping_bytes,
                           const std::size_t payload_size) noexcept
    : mapping_(mapping), mapping_bytes_(mapping_bytes), payload_bytes_(payload_size) {}

PaneSnapshot::PaneSnapshot(PaneSnapshot&& other) noexcept
    : mapping_(std::exchange(other.mapping_, nullptr)),
      mapping_bytes_(std::exchange(other.mapping_bytes_, 0)),
      payload_bytes_(std::exchange(other.payload_bytes_, 0)) {}

auto PaneSnapshot::operator=(PaneSnapshot&& other) noexcept -> PaneSnapshot& {
  if (this != &other) {
    reset();
    mapping_ = std::exchange(other.mapping_, nullptr);
    mapping_bytes_ = std::exchange(other.mapping_bytes_, 0);
    payload_bytes_ = std::exchange(other.payload_bytes_, 0);
  }
  return *this;
}

PaneSnapshot::~PaneSnapshot() { reset(); }

void PaneSnapshot::reset() noexcept {
  if (mapping_ != nullptr) {
    static_cast<void>(::munmap(mapping_, mapping_bytes_));
    mapping_ = nullptr;
  }
  mapping_bytes_ = 0;
  payload_bytes_ = 0;
}

auto PaneSnapshot::payload(const PaneSnapshotMetadata& expected) const noexcept
    -> std::expected<std::span<const std::byte>, PaneSnapshotStorageError> {
  if (!valid() || !valid_metadata(expected)) {
    return std::unexpected(PaneSnapshotStorageError::invalid_options);
  }
  // POSIX mappings are byte-addressable and the mapping length was checked at construction.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto bytes = std::span(reinterpret_cast<const std::byte*>(mapping_), mapping_bytes_);
  if (!header_matches(bytes, expected, payload_bytes_)) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  return bytes.subspan(header_bytes, payload_bytes_);
}

auto PaneSnapshot::payload_bytes() const noexcept -> std::size_t { return payload_bytes_; }

auto PaneSnapshot::valid() const noexcept -> bool {
  return mapping_ != nullptr && payload_bytes_ > 0 &&
         mapping_bytes_ == header_bytes + payload_bytes_;
}

WritablePaneSnapshot::WritablePaneSnapshot(const int descriptor, void* const mapping,
                                           const std::size_t mapping_bytes,
                                           const std::size_t payload_size) noexcept
    : descriptor_(descriptor), mapping_(mapping), mapping_bytes_(mapping_bytes),
      payload_bytes_(payload_size) {}

WritablePaneSnapshot::WritablePaneSnapshot(WritablePaneSnapshot&& other) noexcept
    : descriptor_(std::exchange(other.descriptor_, -1)),
      mapping_(std::exchange(other.mapping_, nullptr)),
      mapping_bytes_(std::exchange(other.mapping_bytes_, 0)),
      payload_bytes_(std::exchange(other.payload_bytes_, 0)) {}

WritablePaneSnapshot::~WritablePaneSnapshot() { reset(); }

void WritablePaneSnapshot::reset() noexcept {
  release_mapping(descriptor_, mapping_, mapping_bytes_);
  payload_bytes_ = 0;
}

auto WritablePaneSnapshot::create(const PaneSnapshotMetadata& metadata,
                                  const std::size_t payload_bytes,
                                  const std::string_view directory) noexcept
    -> std::expected<WritablePaneSnapshot, PaneSnapshotStorageError> {
  if (!valid_metadata(metadata) || directory.empty()) {
    return std::unexpected(PaneSnapshotStorageError::invalid_options);
  }
  if (payload_bytes == 0) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  if (payload_bytes > limits::snapshot_bytes_max) {
    return std::unexpected(PaneSnapshotStorageError::limit_exceeded);
  }

  std::array<char, 4'096> path{};
  if (directory.size() + filename_suffix.size() >= path.size()) {
    return std::unexpected(PaneSnapshotStorageError::invalid_options);
  }
  std::ranges::copy(directory, path.begin());
  std::ranges::copy(filename_suffix, std::span(path).subspan(directory.size()).begin());

  const int descriptor = ::mkstemp(path.data());
  if (descriptor < 0) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  const auto fail = [&](const PaneSnapshotStorageError error) noexcept
      -> std::expected<WritablePaneSnapshot, PaneSnapshotStorageError> {
    static_cast<void>(::close(descriptor));
    static_cast<void>(::unlink(path.data()));
    return std::unexpected(error);
  };

  // fcntl is a POSIX variadic API; these commands use their specified zero/int argument forms.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const int descriptor_flags = ::fcntl(descriptor, F_GETFD);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  if (descriptor_flags < 0 || ::fcntl(descriptor, F_SETFD, descriptor_flags | FD_CLOEXEC) != 0 ||
      ::fchmod(descriptor, S_IRUSR | S_IWUSR) != 0) {
    return fail(PaneSnapshotStorageError::io_error);
  }
  // Removing the only pathname makes crash/process teardown cleanup kernel-owned.
  if (::unlink(path.data()) != 0) {
    return fail(PaneSnapshotStorageError::io_error);
  }

  const auto mapping_bytes = header_bytes + payload_bytes;
  if (::ftruncate(descriptor, static_cast<off_t>(mapping_bytes)) != 0) {
    static_cast<void>(::close(descriptor));
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
  void* const mapping =
      ::mmap(nullptr, mapping_bytes, PROT_READ | PROT_WRITE, MAP_SHARED, descriptor, 0);
  if (mapping == MAP_FAILED) {
    static_cast<void>(::close(descriptor));
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }

  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  encode_header(std::span(reinterpret_cast<std::byte*>(mapping), mapping_bytes), metadata,
                payload_bytes);
  return WritablePaneSnapshot(descriptor, mapping, mapping_bytes, payload_bytes);
}

auto WritablePaneSnapshot::payload() noexcept -> std::span<std::byte> {
  if (mapping_ == nullptr || mapping_bytes_ != header_bytes + payload_bytes_) {
    return {};
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return std::span(reinterpret_cast<std::byte*>(mapping_), mapping_bytes_)
      .subspan(header_bytes, payload_bytes_);
}

auto WritablePaneSnapshot::payload_bytes() const noexcept -> std::size_t { return payload_bytes_; }

auto WritablePaneSnapshot::finish() && noexcept
    -> std::expected<PaneSnapshot, PaneSnapshotStorageError> {
  if (descriptor_ < 0 || mapping_ == nullptr || payload_bytes_ == 0 ||
      mapping_bytes_ != header_bytes + payload_bytes_) {
    return std::unexpected(PaneSnapshotStorageError::invalid_state);
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto bytes = std::span(reinterpret_cast<std::byte*>(mapping_), mapping_bytes_);
  write_little_endian(bytes, payload_hash_offset,
                      snapshot_payload_hash(
                          std::span<const std::byte>(bytes).subspan(header_bytes, payload_bytes_)));
  if (::msync(mapping_, mapping_bytes_, MS_SYNC) != 0 ||
      ::mprotect(mapping_, mapping_bytes_, PROT_READ) != 0) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }
#ifdef MADV_DONTNEED
  // This is only a residency hint. Correctness relies on the unlinked file-backed mapping.
  static_cast<void>(::madvise(mapping_, mapping_bytes_, MADV_DONTNEED));
#endif
  const int descriptor = std::exchange(descriptor_, -1);
  if (::close(descriptor) != 0) {
    return std::unexpected(PaneSnapshotStorageError::io_error);
  }

  PaneSnapshot snapshot(mapping_, mapping_bytes_, payload_bytes_);
  mapping_ = nullptr;
  mapping_bytes_ = 0;
  payload_bytes_ = 0;
  return snapshot;
}

} // namespace lemma::core
