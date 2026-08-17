#ifndef LEMMA_CORE_SESSION_HPP
#define LEMMA_CORE_SESSION_HPP

#include "lemma/geometry.hpp"
#include "lemma/id.hpp"
#include "lemma/limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::core {

inline constexpr std::size_t panes_per_session_max =
    static_cast<std::size_t>(limits::panes_hard_max / limits::sessions_hard_max);
inline constexpr std::size_t tabs_per_session_max =
    static_cast<std::size_t>(limits::tabs_hard_max / limits::sessions_hard_max);
inline constexpr std::size_t panes_per_tab_max = panes_per_session_max;
inline constexpr std::size_t layout_nodes_per_tab_max = (panes_per_tab_max * 2U) - 1U;

static_assert(panes_per_session_max > 0);
static_assert(tabs_per_session_max > 0);

enum class LaunchEnvironmentMode : std::uint8_t {
  inherit,
  replace,
};

enum class SplitAxis : std::uint8_t {
  left_right,
  top_bottom,
};

struct Pane final {
  PaneId id;
  PaneRectangle rectangle{};
};

struct PaneSlot final {
  std::unique_ptr<Pane> pane;
  std::uint32_t generation{0};
};

struct LayoutNode final {
  bool active{false};
  bool leaf{true};
  PaneId pane;
  std::int16_t parent{-1};
  std::int16_t first{-1};
  std::int16_t second{-1};
  SplitAxis axis{SplitAxis::left_right};
};

struct Tab final {
  Tab(TabId assigned_id, std::unique_ptr<Pane> first_pane) noexcept;

  Tab(const Tab&) = delete;
  auto operator=(const Tab&) -> Tab& = delete;
  Tab(Tab&&) = delete;
  auto operator=(Tab&&) -> Tab& = delete;
  ~Tab() = default;

  TabId id;
  std::array<PaneSlot, panes_per_tab_max> panes{};
  std::array<LayoutNode, layout_nodes_per_tab_max> layout{};
  // Inactive tabs retain their last usable geometry while continuing to process PTY output.
  std::uint16_t layout_columns{80};
  std::uint16_t layout_rows{24};
  PaneId focused_pane;
  PaneId previous_pane;
  bool zoomed{false};
  bool layout_suspended{false};
};

struct TabSlot final {
  std::unique_ptr<Tab> tab;
  std::uint32_t generation{0};
};

enum class CopyModeFeedback : std::uint8_t {
  none,
  no_match,
  empty_selection,
  clipboard_busy,
  too_large,
  failed,
};

enum class CopySearchDirection : std::uint8_t {
  forward,
  backward,
};

struct CopyModeState final {
  std::array<char, limits::search_query_bytes_max> query{};
  std::size_t query_size{0};
  std::uint64_t viewport_offset{0};
  CopyModeFeedback feedback{CopyModeFeedback::none};
  CopySearchDirection search_direction{CopySearchDirection::forward};
  bool active{false};
  bool extending{false};
  bool search_entry{false};
  bool search_pending{false};

  [[nodiscard]] auto query_view() const noexcept -> std::string_view {
    return {query.data(), query_size};
  }
};

struct AttachmentPaneTarget final {
  TabId tab;
  PaneId pane;

  friend constexpr auto operator==(const AttachmentPaneTarget&,
                                   const AttachmentPaneTarget&) noexcept -> bool = default;
};

enum class MouseCaptureOwner : std::uint8_t {
  application,
  selection,
};

struct MouseCapture final {
  AttachmentPaneTarget target;
  MouseCaptureOwner owner{MouseCaptureOwner::application};
};

struct Attachment final {
  AttachmentId id;
  SessionId session;
  std::uint16_t columns{80};
  std::uint16_t rows{24};
  std::optional<AttachmentPaneTarget> selection_target;
  std::optional<MouseCapture> mouse_capture;
  CopyModeState copy_mode;
};

struct Session {
  Session(std::string_view session_name, std::string_view initial_working_directory,
          std::span<const std::byte> initial_environment,
          LaunchEnvironmentMode initial_environment_mode) noexcept;

  Session(const Session&) = delete;
  auto operator=(const Session&) -> Session& = delete;
  Session(Session&&) = delete;
  auto operator=(Session&&) -> Session& = delete;
  ~Session() = default;

  [[nodiscard]] auto session_name() const noexcept -> std::string_view;
  [[nodiscard]] auto cwd() const noexcept -> std::string_view;
  [[nodiscard]] auto launch_environment() const noexcept -> std::span<const std::byte>;

  SessionId id;
  std::array<char, limits::session_name_bytes_max> name{};
  std::size_t name_size{0};
  std::array<char, limits::working_directory_bytes_max + 1U> working_directory{};
  std::size_t working_directory_size{0};
  std::array<std::byte, limits::environment_bytes_max> environment{};
  std::size_t environment_size{0};
  LaunchEnvironmentMode environment_mode{LaunchEnvironmentMode::inherit};
  std::array<TabSlot, tabs_per_session_max> tabs{};
  TabId active_tab;
  TabId previous_tab;
  bool active{true};
  bool theme_bound{false};
};

} // namespace lemma::core

#endif // LEMMA_CORE_SESSION_HPP
