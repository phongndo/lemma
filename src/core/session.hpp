#ifndef LEMMA_CORE_SESSION_HPP
#define LEMMA_CORE_SESSION_HPP

#include "core/layout.hpp"
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
#include <vector>

namespace lemma::core {

inline constexpr std::size_t panes_per_session_max = pane_layout_panes_max;
inline constexpr std::size_t tabs_per_session_max =
    static_cast<std::size_t>(limits::tabs_hard_max / limits::sessions_hard_max);
inline constexpr std::size_t panes_per_tab_max = pane_layout_panes_max;
inline constexpr std::size_t layout_nodes_per_tab_max = pane_layout_nodes_max;

static_assert(panes_per_session_max > 0);
static_assert(tabs_per_session_max > 0);

enum class LaunchEnvironmentMode : std::uint8_t {
  inherit,
  replace,
};

struct PaneLaunchCommand final {
  std::vector<std::byte> bytes;
};

struct Pane final {
  [[nodiscard]] auto launch_command() const noexcept -> std::span<const std::byte> {
    return launch_command_storage == nullptr
               ? std::span<const std::byte>{}
               : std::span<const std::byte>(launch_command_storage->bytes);
  }

  PaneId id;
  TabId tab;
  PaneRectangle rectangle{};
  // Pane-owned semantic launch intent. Null means the account login shell. Keeping cold launch
  // payload storage indirect avoids adding a vector to every hot layout Pane.
  std::unique_ptr<PaneLaunchCommand> launch_command_storage;
};

struct PaneSlot final {
  std::unique_ptr<Pane> pane;
  std::uint32_t generation{0};
};

// One bounded permutation owns display order. Tab storage slots and stable TabIds never encode
// presentation position, so reorder cannot invalidate identity or scheduler traversal.
class TabOrder final {
public:
  [[nodiscard]] auto append(TabId tab) noexcept -> bool;
  [[nodiscard]] auto erase(TabId tab) noexcept -> bool;
  [[nodiscard]] auto place_before(TabId moving, std::optional<TabId> anchor) noexcept -> bool;
  [[nodiscard]] auto at(std::size_t position) const noexcept -> std::optional<TabId>;
  [[nodiscard]] auto position_of(TabId tab) const noexcept -> std::optional<std::size_t>;
  [[nodiscard]] constexpr auto size() const noexcept -> std::size_t { return size_; }
  [[nodiscard]] constexpr auto empty() const noexcept -> bool { return size_ == 0; }

private:
  std::array<TabId, tabs_per_session_max> ids_{};
  std::size_t size_{0};
};

class TabTitleOverride final {
public:
  [[nodiscard]] auto view() const noexcept -> std::string_view;
  [[nodiscard]] auto set(std::string_view title) noexcept -> bool;

private:
  std::array<char, limits::tab_title_bytes_max> bytes_{};
  std::size_t size_{0};
};

struct Tab final {
  Tab(TabId assigned_id, PaneId first_pane) noexcept;

  Tab(const Tab&) = delete;
  auto operator=(const Tab&) -> Tab& = delete;
  Tab(Tab&&) = delete;
  auto operator=(Tab&&) -> Tab& = delete;
  ~Tab() = default;

  [[nodiscard]] auto title_override() const noexcept -> std::string_view;
  [[nodiscard]] auto set_title_override(std::string_view title) noexcept -> bool;

  TabId id;
  PaneLayout layout;
  // Inactive tabs retain their last usable geometry while continuing to process PTY output.
  std::uint16_t layout_columns{80};
  std::uint16_t layout_rows{24};
  PaneId focused_pane;
  PaneId previous_pane;
  TabTitleOverride title;
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

enum class CopyModePhase : std::uint8_t {
  inactive,
  navigation,
  visual_character,
  visual_line,
  visual_block,
  search_prompt,
  searching,
};

enum class CopyPendingChord : std::uint8_t {
  none,
  go,
};

struct CopyModeState final {
  std::array<char, limits::search_query_bytes_max> query{};
  std::array<char, limits::search_query_bytes_max> draft_query{};
  std::size_t query_size{0};
  std::size_t draft_query_size{0};
  // Explicit copy mode snapshots an absolute viewport policy across reflow/output mutations.
  // Ordinary wheel scrolling remains terminal-owned and does not populate this value.
  std::uint64_t viewport_offset{0};
  CopyModeFeedback feedback{CopyModeFeedback::none};
  CopySearchDirection search_direction{CopySearchDirection::forward};
  CopySearchDirection prompt_search_direction{CopySearchDirection::forward};
  CopyModePhase phase{CopyModePhase::inactive};
  CopyModePhase phase_before_search{CopyModePhase::navigation};
  CopyPendingChord pending_chord{CopyPendingChord::none};

  [[nodiscard]] constexpr auto active() const noexcept -> bool {
    return phase != CopyModePhase::inactive;
  }
  [[nodiscard]] constexpr auto selecting() const noexcept -> bool {
    return phase == CopyModePhase::visual_character || phase == CopyModePhase::visual_line ||
           phase == CopyModePhase::visual_block;
  }
  [[nodiscard]] auto query_view() const noexcept -> std::string_view {
    return {query.data(), query_size};
  }
  [[nodiscard]] auto draft_query_view() const noexcept -> std::string_view {
    return {draft_query.data(), draft_query_size};
  }
};

enum class RenamePromptKind : std::uint8_t {
  inactive,
  session,
  tab,
};

enum class RenamePromptFeedback : std::uint8_t {
  none,
  invalid,
  conflict,
};

// The Attachment owns transient editing state. Stable semantic identity is captured when the
// prompt opens; no Session or Tab mutation occurs until the completed value is dispatched.
struct RenamePromptState final {
  std::array<char, limits::tab_title_bytes_max> text{};
  std::size_t size{0};
  std::size_t cursor{0};
  TabId tab;
  RenamePromptKind kind{RenamePromptKind::inactive};
  RenamePromptFeedback feedback{RenamePromptFeedback::none};

  [[nodiscard]] constexpr auto active() const noexcept -> bool {
    return kind != RenamePromptKind::inactive;
  }
  [[nodiscard]] auto view() const noexcept -> std::string_view { return {text.data(), size}; }
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
  divider,
  status_tab,
  discard_until_release,
};

struct MouseCapture final {
  AttachmentPaneTarget target;
  // Divider capture uses target.pane and peer_pane as generation-safe subtree representatives.
  // The Attachment owns this ephemeral gesture identity; PaneLayout remains the ratio authority.
  PaneId peer_pane;
  // Status-tab capture owns a non-authoritative live ordering preview. The stable source is
  // target.tab and this stable anchor has the same "place before" meaning as TabPlacementCommand;
  // an invalid anchor means the end.
  TabId status_tab_before;
  MouseCaptureOwner owner{MouseCaptureOwner::application};
  SplitAxis divider_axis{SplitAxis::left_right};
};

struct Attachment final {
  AttachmentId id;
  SessionId session;
  std::uint16_t columns{80};
  std::uint16_t rows{24};
  std::optional<AttachmentPaneTarget> selection_target;
  std::optional<MouseCapture> mouse_capture;
  CopyModeState copy_mode;
  RenamePromptState rename_prompt;
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
  [[nodiscard]] auto rename(std::string_view session_name) noexcept -> bool;
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
  // Core-owned ordering used only to resolve an omitted CLI attach target.
  std::uint64_t activity_order{0};
  std::array<PaneSlot, panes_per_session_max> panes{};
  std::array<TabSlot, tabs_per_session_max> tabs{};
  TabOrder tab_order;
  TabId active_tab;
  TabId previous_tab;
  bool active{true};
  bool theme_bound{false};
};

} // namespace lemma::core

#endif // LEMMA_CORE_SESSION_HPP
