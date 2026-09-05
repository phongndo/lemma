#include "core/pane_snapshot_storage.hpp"

#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdlib>
#include <dirent.h>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace lemma::core {

// Deliberately corrupt only the backing object, never the retained key or authoritative terminal.
struct PaneSnapshotStorageTestAccess final {
  static auto descriptor(const PaneSnapshot& snapshot) noexcept -> int {
    return snapshot.descriptor_;
  }
  static auto descriptor(const WritablePaneSnapshot& snapshot) noexcept -> int {
    return snapshot.descriptor_;
  }
};

namespace {

class TemporaryDirectory final {
public:
  TemporaryDirectory() {
    std::ranges::copy(std::string_view{path_template}, path_.begin());
    EXPECT_NE(::mkdtemp(path_.data()), nullptr);
  }

  TemporaryDirectory(const TemporaryDirectory&) = delete;
  auto operator=(const TemporaryDirectory&) -> TemporaryDirectory& = delete;
  TemporaryDirectory(TemporaryDirectory&&) = delete;
  auto operator=(TemporaryDirectory&&) -> TemporaryDirectory& = delete;

  ~TemporaryDirectory() { EXPECT_EQ(::rmdir(path_.data()), 0); }

  [[nodiscard]] auto path() const noexcept -> std::string_view { return path_.data(); }

  [[nodiscard]] auto empty() const noexcept -> bool {
    DIR* const directory = ::opendir(path_.data());
    if (directory == nullptr) {
      return false;
    }
    bool result = true;
    while (const auto* entry = ::readdir(directory)) {
      // POSIX exposes d_name as its fixed C array.
      // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-array-to-pointer-decay)
      const std::string_view name(entry->d_name);
      if (name != "." && name != "..") {
        result = false;
        break;
      }
    }
    static_cast<void>(::closedir(directory));
    return result;
  }

private:
  static constexpr std::string_view path_template = "/tmp/lemma-snapshot-test-XXXXXX";
  std::array<char, 128> path_{};
};

[[nodiscard]] auto test_metadata() noexcept -> PaneSnapshotMetadata {
  return {
      .compatibility = current_pane_snapshot_compatibility(),
      .geometry = {.columns = 80, .rows = 24, .cell_width_px = 9, .cell_height_px = 18},
  };
}

// GoogleTest assertions inflate the measured branch count.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneSnapshotStorageTest, SealsUnlinkedExactPayloadAndValidatesIdentity) {
  TemporaryDirectory directory;
  constexpr std::size_t payload_bytes = 4'097;
  auto writable_result =
      WritablePaneSnapshot::create(test_metadata(), payload_bytes, directory.path());
  ASSERT_TRUE(writable_result.has_value());
  EXPECT_TRUE(directory.empty());
  auto writable = std::move(*writable_result);
  auto destination = writable.payload();
  ASSERT_EQ(destination.size(), payload_bytes);
  for (std::size_t index = 0; index < destination.size(); ++index) {
    destination.subspan(index, 1U).front() = static_cast<std::byte>(index % 251U);
  }

  auto snapshot_result = std::move(writable).finish();
  ASSERT_TRUE(snapshot_result.has_value());
  auto snapshot = std::move(*snapshot_result);
  // finish() consumes the backing ownership and explicitly leaves an empty, queryable writer.
  // NOLINTNEXTLINE(bugprone-use-after-move)
  EXPECT_TRUE(writable.payload().empty());
  EXPECT_EQ(writable.payload_bytes(), 0U);
  EXPECT_TRUE(snapshot.valid());
  EXPECT_EQ(snapshot.payload_bytes(), payload_bytes);
  const auto payload = snapshot.payload(test_metadata());
  ASSERT_TRUE(payload.has_value());
  ASSERT_EQ(payload->bytes().size(), payload_bytes);
  for (std::size_t index = 0; index < payload->bytes().size(); ++index) {
    EXPECT_EQ(payload->bytes().subspan(index, 1U).front(), static_cast<std::byte>(index % 251U));
  }

  auto wrong_pin = test_metadata();
  wrong_pin.compatibility.ghostty_commit = "0000000000000000000000000000000000000000";
  const auto stale_pin = snapshot.payload(wrong_pin);
  ASSERT_FALSE(stale_pin.has_value());
  EXPECT_EQ(stale_pin.error(), PaneSnapshotStorageError::invalid_state);

  auto wrong_profile = test_metadata();
  wrong_profile.compatibility.ghostty_profile = "minimal-snapshot";
  const auto stale_profile = snapshot.payload(wrong_profile);
  ASSERT_FALSE(stale_profile.has_value());
  EXPECT_EQ(stale_profile.error(), PaneSnapshotStorageError::invalid_state);

  auto wrong_geometry = test_metadata();
  ++wrong_geometry.geometry.columns;
  const auto stale_geometry = snapshot.payload(wrong_geometry);
  ASSERT_FALSE(stale_geometry.has_value());
  EXPECT_EQ(stale_geometry.error(), PaneSnapshotStorageError::invalid_state);
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneSnapshotStorageTest, RejectsInvalidBoundsAndIoBeforePublishingStorage) {
  TemporaryDirectory directory;
  const auto empty = WritablePaneSnapshot::create(test_metadata(), 0, directory.path());
  ASSERT_FALSE(empty.has_value());
  EXPECT_EQ(empty.error(), PaneSnapshotStorageError::invalid_state);

  const auto oversized = WritablePaneSnapshot::create(
      test_metadata(), limits::snapshot_bytes_max + 1U, directory.path());
  ASSERT_FALSE(oversized.has_value());
  EXPECT_EQ(oversized.error(), PaneSnapshotStorageError::limit_exceeded);

  auto invalid_geometry = test_metadata();
  invalid_geometry.geometry.columns = 0;
  const auto invalid = WritablePaneSnapshot::create(invalid_geometry, 1, directory.path());
  ASSERT_FALSE(invalid.has_value());
  EXPECT_EQ(invalid.error(), PaneSnapshotStorageError::invalid_options);

  const auto missing_directory =
      WritablePaneSnapshot::create(test_metadata(), 1, "/missing/lemma-snapshot-directory");
  ASSERT_FALSE(missing_directory.has_value());
  EXPECT_EQ(missing_directory.error(), PaneSnapshotStorageError::io_error);
  EXPECT_TRUE(directory.empty());
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneSnapshotStorageTest, EncodesAndRestoresTerminalThroughAuthenticatedPlaintext) {
  vt::TerminalOptions options;
  options.size = {.columns = 24, .rows = 4, .cell_width_px = 8, .cell_height_px = 16};
  options.scrollback_lines_max = 128;
  options.snapshot_continuation_bytes_max = 1'024;
  auto terminal_result = vt::Terminal::create(options);
  ASSERT_TRUE(terminal_result.has_value());
  auto terminal = std::move(*terminal_result);
  constexpr std::string_view content = "mapped snapshot\r\nhistory\r\nvisible";
  terminal.write(std::as_bytes(std::span(content.data(), content.size())));

  const auto required = terminal.snapshot_size();
  ASSERT_TRUE(required.has_value());
  const PaneSnapshotMetadata metadata{
      .compatibility = current_pane_snapshot_compatibility(),
      .geometry = options.size,
  };
  TemporaryDirectory directory;
  auto writable_result = WritablePaneSnapshot::create(metadata, *required, directory.path());
  ASSERT_TRUE(writable_result.has_value());
  auto writable = std::move(*writable_result);
  ASSERT_EQ(terminal.encode_snapshot(writable.payload()), required);
  auto snapshot_result = std::move(writable).finish();
  ASSERT_TRUE(snapshot_result.has_value());
  auto snapshot = std::move(*snapshot_result);

  const auto encoded = snapshot.payload(metadata);
  ASSERT_TRUE(encoded.has_value());
  auto restored_result = vt::Terminal::restore_snapshot(options, encoded->bytes());
  ASSERT_TRUE(restored_result.has_value());
  auto restored = std::move(*restored_result);
  std::array<std::byte, 4'096> canonical_text{};
  std::array<std::byte, 4'096> restored_text{};
  const auto canonical_size = terminal.format_screen(vt::ScreenFormat::plain, canonical_text);
  const auto restored_size = restored.format_screen(vt::ScreenFormat::plain, restored_text);
  ASSERT_TRUE(canonical_size.has_value());
  ASSERT_TRUE(restored_size.has_value());
  EXPECT_TRUE(std::ranges::equal(std::span(canonical_text).first(*canonical_size),
                                 std::span(restored_text).first(*restored_size)));
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneSnapshotStorageTest, CiphertextIsRandomizedAndContainsNoPlaintext) {
  TemporaryDirectory directory;
  constexpr std::string_view secret = "SCROLLBACK-SECRET-0123456789";
  std::array<std::vector<std::byte>, 2> stored;
  for (auto& ciphertext : stored) {
    auto writable = WritablePaneSnapshot::create(test_metadata(), secret.size(), directory.path());
    ASSERT_TRUE(writable.has_value());
    std::ranges::copy(std::as_bytes(std::span(secret)), writable->payload().begin());
    auto snapshot = std::move(*writable).finish();
    ASSERT_TRUE(snapshot.has_value());
    const auto descriptor = PaneSnapshotStorageTestAccess::descriptor(*snapshot);
    struct stat status{};
    ASSERT_EQ(::fstat(descriptor, &status), 0);
    EXPECT_EQ(status.st_nlink, 0U);
    EXPECT_EQ(status.st_mode & 0777, 0600);
    // POSIX fcntl uses its specified zero-argument form.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    EXPECT_NE(::fcntl(descriptor, F_GETFD) & FD_CLOEXEC, 0);
    ciphertext.resize(static_cast<std::size_t>(status.st_size));
    ASSERT_EQ(::pread(descriptor, ciphertext.data(), ciphertext.size(), 0), status.st_size);
    EXPECT_TRUE(std::ranges::search(ciphertext, std::as_bytes(std::span(secret))).empty());
    const auto plaintext = snapshot->payload(test_metadata());
    ASSERT_TRUE(plaintext.has_value());
    EXPECT_TRUE(std::ranges::equal(plaintext->bytes(), std::as_bytes(std::span(secret))));
  }
  EXPECT_NE(stored.front(), stored.back());
  EXPECT_TRUE(directory.empty());
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(PaneSnapshotStorageTest, RejectsTamperingTruncationReorderingAndTrailingBytes) {
  TemporaryDirectory directory;
  constexpr std::size_t chunk = std::size_t{64} * 1'024U;
  for (const auto mutation : {0, 1, 2, 3, 4, 5}) {
    SCOPED_TRACE(mutation);
    auto writable =
        WritablePaneSnapshot::create(test_metadata(), (chunk * 2U) + 1U, directory.path());
    ASSERT_TRUE(writable.has_value());
    std::ranges::fill(writable->payload(), std::byte{0x61});
    auto snapshot = std::move(*writable).finish();
    ASSERT_TRUE(snapshot.has_value());
    const auto descriptor = PaneSnapshotStorageTestAccess::descriptor(*snapshot);
    struct stat status{};
    ASSERT_EQ(::fstat(descriptor, &status), 0);
    std::vector<std::byte> original(static_cast<std::size_t>(status.st_size));
    ASSERT_EQ(::pread(descriptor, original.data(), original.size(), 0), status.st_size);
    auto changed = original;
    switch (mutation) {
    case 0:
      changed.front() ^= std::byte{1}; // Authenticated Lemma envelope.
      break;
    case 1:
      changed.at(96) ^= std::byte{1}; // Secretstream nonce header.
      break;
    case 2:
      changed.back() ^= std::byte{1}; // Final authentication tag.
      break;
    case 3:
      changed.pop_back();
      break;
    case 4:
      changed.push_back(std::byte{0});
      break;
    case 5:
      std::swap_ranges(changed.begin() + 120, changed.begin() + 120 + chunk + 17,
                       changed.begin() + 120 + chunk + 17);
      break;
    default:
      FAIL();
    }
    ASSERT_EQ(::ftruncate(descriptor, static_cast<off_t>(changed.size())), 0);
    ASSERT_EQ(::pwrite(descriptor, changed.data(), changed.size(), 0),
              static_cast<ssize_t>(changed.size()));
    const auto invalid = snapshot->payload(test_metadata());
    ASSERT_FALSE(invalid.has_value());
    EXPECT_EQ(invalid.error(), PaneSnapshotStorageError::invalid_state);
    // Failed authentication must not poison a later operation's stream state or expose its prefix.
    ASSERT_EQ(::ftruncate(descriptor, status.st_size), 0);
    ASSERT_EQ(::pwrite(descriptor, original.data(), original.size(), 0), status.st_size);
    EXPECT_TRUE(snapshot->payload(test_metadata()).has_value());
  }
}

TEST(PaneSnapshotStorageTest, StorageWriteFailureDoesNotPublishASnapshot) {
  TemporaryDirectory directory;
  auto writable = WritablePaneSnapshot::create(test_metadata(), 100, directory.path());
  ASSERT_TRUE(writable.has_value());
  // Replacing the test-owned descriptor with a read-only object fails pwrite portably, without
  // relying on Linux /dev/full or causing a SIGBUS through a writable file mapping.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
  const auto read_only = ::open("/dev/null", O_RDONLY);
  ASSERT_GE(read_only, 0);
  const auto descriptor = PaneSnapshotStorageTestAccess::descriptor(*writable);
  ASSERT_EQ(::dup2(read_only, descriptor), descriptor);
  ASSERT_EQ(::close(read_only), 0);
  const auto snapshot = std::move(*writable).finish();
  ASSERT_FALSE(snapshot.has_value());
  EXPECT_EQ(snapshot.error(), PaneSnapshotStorageError::io_error);
  EXPECT_EQ(writable->payload().size(), 100U);
}

} // namespace
} // namespace lemma::core
