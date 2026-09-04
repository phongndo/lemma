#ifndef LEMMA_CORE_PANE_SNAPSHOT_STORAGE_HPP
#define LEMMA_CORE_PANE_SNAPSHOT_STORAGE_HPP

#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <span>
#include <string_view>

namespace lemma::core {

enum class PaneSnapshotStorageError : std::uint8_t {
  invalid_options,
  limit_exceeded,
  io_error,
  invalid_state,
};

struct PaneSnapshotCompatibility final {
  std::string_view ghostty_commit;
  std::string_view ghostty_profile;

  friend constexpr auto operator==(const PaneSnapshotCompatibility&,
                                   const PaneSnapshotCompatibility&) noexcept -> bool = default;
};

struct PaneSnapshotMetadata final {
  PaneSnapshotCompatibility compatibility;
  vt::TerminalSize geometry;
};

[[nodiscard]] auto current_pane_snapshot_compatibility() noexcept -> PaneSnapshotCompatibility;

// Anonymous, operation-owned plaintext. Never file-backed; wiped and unmapped at destruction.
// The decoder must be destroyed before this owner. Ordinary RAM/swap has the live-terminal threat
// model; only cryptographic key storage is required to be locked against swap.
class PaneSnapshotPlaintext final {
public:
  PaneSnapshotPlaintext(PaneSnapshotPlaintext&& other) noexcept;
  auto operator=(PaneSnapshotPlaintext&& other) -> PaneSnapshotPlaintext& = delete;
  PaneSnapshotPlaintext(const PaneSnapshotPlaintext&) = delete;
  auto operator=(const PaneSnapshotPlaintext&) -> PaneSnapshotPlaintext& = delete;
  ~PaneSnapshotPlaintext();

  [[nodiscard]] auto bytes() const noexcept -> std::span<const std::byte>;

private:
  friend class PaneSnapshot;
  friend class WritablePaneSnapshot;
  PaneSnapshotPlaintext(void* mapping, std::size_t size) noexcept;
  [[nodiscard]] static auto create(std::size_t size) noexcept
      -> std::expected<PaneSnapshotPlaintext, PaneSnapshotStorageError>;
  [[nodiscard]] auto writable_bytes() noexcept -> std::span<std::byte>;
  void reset() noexcept;

  void* mapping_;
  std::size_t size_;
};

struct PaneSnapshotSecret;

class PaneSnapshot final {
public:
  PaneSnapshot() noexcept;
  PaneSnapshot(PaneSnapshot&& other) noexcept;
  auto operator=(PaneSnapshot&& other) noexcept -> PaneSnapshot&;
  PaneSnapshot(const PaneSnapshot&) = delete;
  auto operator=(const PaneSnapshot&) -> PaneSnapshot& = delete;
  ~PaneSnapshot();

  // Authenticates the complete envelope and ordered ciphertext before exposing any plaintext.
  [[nodiscard]] auto payload(const PaneSnapshotMetadata& expected) const noexcept
      -> std::expected<PaneSnapshotPlaintext, PaneSnapshotStorageError>;
  [[nodiscard]] auto payload_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto valid() const noexcept -> bool;

private:
  friend class WritablePaneSnapshot;
  friend struct PaneSnapshotStorageTestAccess;
  PaneSnapshot(int descriptor, std::size_t payload_size,
               std::unique_ptr<PaneSnapshotSecret> secret) noexcept;
  void reset() noexcept;

  int descriptor_{-1};
  std::size_t payload_bytes_{0};
  std::unique_ptr<PaneSnapshotSecret> secret_;
};

class WritablePaneSnapshot final {
public:
  [[nodiscard]] static auto create(const PaneSnapshotMetadata& metadata, std::size_t payload_bytes,
                                   std::string_view directory = "/tmp") noexcept
      -> std::expected<WritablePaneSnapshot, PaneSnapshotStorageError>;

  WritablePaneSnapshot(WritablePaneSnapshot&& other) noexcept;
  auto operator=(WritablePaneSnapshot&& other) -> WritablePaneSnapshot& = delete;
  WritablePaneSnapshot(const WritablePaneSnapshot&) = delete;
  auto operator=(const WritablePaneSnapshot&) -> WritablePaneSnapshot& = delete;
  ~WritablePaneSnapshot();

  [[nodiscard]] auto payload() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto payload_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto finish() && noexcept -> std::expected<PaneSnapshot, PaneSnapshotStorageError>;

private:
  friend struct PaneSnapshotStorageTestAccess;
  WritablePaneSnapshot(int descriptor, PaneSnapshotPlaintext plaintext,
                       std::unique_ptr<PaneSnapshotSecret> secret) noexcept;

  int descriptor_;
  PaneSnapshotPlaintext plaintext_;
  std::unique_ptr<PaneSnapshotSecret> secret_;
};

} // namespace lemma::core

#endif // LEMMA_CORE_PANE_SNAPSHOT_STORAGE_HPP
