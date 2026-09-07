#ifndef LEMMA_CORE_PANE_SNAPSHOT_WORK_HPP
#define LEMMA_CORE_PANE_SNAPSHOT_WORK_HPP

#include "core/pane_snapshot_storage.hpp"
#include "lemma/terminal/terminal.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <string_view>
#include <utility>
#include <variant>

namespace lemma::core {

enum class PaneResidencyPhase : std::uint8_t { active, parking, parked, unparking };
enum class SnapshotTestCorruption : std::uint8_t { none, ghostty_payload };

// Exclusive operation owner. Contains no Runtime pointers, quota authority, or borrowed callbacks.
// Runtime transfers this owner to the snapshot worker before any snapshot traversal or storage I/O.
class PaneSnapshotWork final {
public:
  explicit PaneSnapshotWork(vt::Terminal&& terminal) noexcept;
  ~PaneSnapshotWork();
  PaneSnapshotWork(const PaneSnapshotWork&) = delete;
  auto operator=(const PaneSnapshotWork&) -> PaneSnapshotWork& = delete;
  PaneSnapshotWork(PaneSnapshotWork&&) = delete;
  auto operator=(PaneSnapshotWork&&) -> PaneSnapshotWork& = delete;

  [[nodiscard]] auto phase() const noexcept -> PaneResidencyPhase;
  [[nodiscard]] auto active_terminal() noexcept -> vt::Terminal*;
  [[nodiscard]] auto active_terminal() const noexcept -> const vt::Terminal*;
  [[nodiscard]] auto snapshot_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto begin_parking(const vt::TerminalOptions& options,
                                   std::string_view directory = "/tmp") noexcept
      -> std::expected<std::size_t, vt::Error>;
  [[nodiscard]] auto finish_parking(SnapshotTestCorruption corruption) noexcept
      -> std::expected<void, vt::Error>;
  void cancel_parking() noexcept;
  [[nodiscard]] auto begin_unparking() noexcept -> std::expected<void, vt::Error>;
  [[nodiscard]] auto restore_one_history_page() noexcept -> std::expected<bool, vt::Error>;
  void cancel_unparking() noexcept;

private:
  struct Active final {
    explicit Active(vt::Terminal&& value) noexcept : terminal(std::move(value)) {}
    vt::Terminal terminal;
  };
  struct Parking final {
    Parking(vt::Terminal&& terminal_value, WritablePaneSnapshot&& storage_value,
            const vt::TerminalOptions& options_value) noexcept
        : terminal(std::move(terminal_value)), storage(std::move(storage_value)),
          options(options_value) {}
    vt::Terminal terminal;
    WritablePaneSnapshot storage;
    vt::TerminalOptions options;
  };
  struct Parked final {
    Parked(PaneSnapshot&& storage_value, const vt::TerminalOptions& options_value) noexcept
        : storage(std::move(storage_value)), options(options_value) {}
    PaneSnapshot storage;
    vt::TerminalOptions options;
  };
  struct Unparking final {
    Unparking(PaneSnapshot&& storage_value, const vt::TerminalOptions& options_value,
              PaneSnapshotPlaintext&& plaintext_value,
              vt::TerminalSnapshotRestore&& restore_value) noexcept
        : storage(std::move(storage_value)), options(options_value),
          plaintext(std::move(plaintext_value)), restore(std::move(restore_value)) {}
    PaneSnapshot storage;
    vt::TerminalOptions options;
    PaneSnapshotPlaintext plaintext;
    // Decoder destruction MUST precede wiping/unmapping its borrowed plaintext.
    vt::TerminalSnapshotRestore restore;
  };
  struct ColdResidency final {
    template <typename State, typename... Arguments>
    explicit ColdResidency(std::in_place_type_t<State> type, Arguments&&... arguments) noexcept
        : state(type, std::forward<Arguments>(arguments)...) {}
    std::variant<Parking, Parked, Unparking> state;
  };
  std::variant<Active, std::unique_ptr<ColdResidency>> state_;
};

} // namespace lemma::core
#endif
