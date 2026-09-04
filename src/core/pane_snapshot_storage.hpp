#ifndef LEMMA_CORE_PANE_SNAPSHOT_STORAGE_HPP
#define LEMMA_CORE_PANE_SNAPSHOT_STORAGE_HPP

#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
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

class PaneSnapshot final {
public:
  PaneSnapshot() noexcept = default;
  PaneSnapshot(PaneSnapshot&& other) noexcept;
  auto operator=(PaneSnapshot&& other) noexcept -> PaneSnapshot&;

  PaneSnapshot(const PaneSnapshot&) = delete;
  auto operator=(const PaneSnapshot&) -> PaneSnapshot& = delete;

  ~PaneSnapshot();

  [[nodiscard]] auto payload(const PaneSnapshotMetadata& expected) const noexcept
      -> std::expected<std::span<const std::byte>, PaneSnapshotStorageError>;
  [[nodiscard]] auto payload_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto valid() const noexcept -> bool;

private:
  friend class WritablePaneSnapshot;

  PaneSnapshot(void* mapping, std::size_t mapping_bytes, std::size_t payload_size) noexcept;
  void reset() noexcept;

  void* mapping_{nullptr};
  std::size_t mapping_bytes_{0};
  std::size_t payload_bytes_{0};
};

class WritablePaneSnapshot final {
public:
  [[nodiscard]] static auto create(const PaneSnapshotMetadata& metadata, std::size_t payload_bytes,
                                   std::string_view directory = "/tmp") noexcept
      -> std::expected<WritablePaneSnapshot, PaneSnapshotStorageError>;

  WritablePaneSnapshot(WritablePaneSnapshot&& other) noexcept;
  auto operator=(WritablePaneSnapshot&& other) noexcept -> WritablePaneSnapshot& = delete;

  WritablePaneSnapshot(const WritablePaneSnapshot&) = delete;
  auto operator=(const WritablePaneSnapshot&) -> WritablePaneSnapshot& = delete;

  ~WritablePaneSnapshot();

  [[nodiscard]] auto payload() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto payload_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto finish() && noexcept -> std::expected<PaneSnapshot, PaneSnapshotStorageError>;

private:
  WritablePaneSnapshot(int descriptor, void* mapping, std::size_t mapping_bytes,
                       std::size_t payload_size) noexcept;
  void reset() noexcept;

  int descriptor_{-1};
  void* mapping_{nullptr};
  std::size_t mapping_bytes_{0};
  std::size_t payload_bytes_{0};
};

} // namespace lemma::core

#endif // LEMMA_CORE_PANE_SNAPSHOT_STORAGE_HPP
