#ifndef LEMMA_TERMINAL_TERMINAL_HPP
#define LEMMA_TERMINAL_TERMINAL_HPP

#include "lemma/limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <optional>
#include <span>
#include <string_view>

namespace lemma::vt {

// Version of the privately linked terminal engine. The returned view has static lifetime.
[[nodiscard]] auto library_version() noexcept -> std::span<const std::uint8_t>;

enum class Error : std::uint8_t {
  invalid_options,
  out_of_memory,
  invalid_state,
  out_of_space,
  io_error,
  limit_exceeded,
};

enum class BuildOptimization : std::uint8_t {
  debug,
  release_safe,
  release_small,
  release_fast,
};

struct LibraryBuildInfo final {
  std::span<const std::uint8_t> version;
  BuildOptimization optimization{BuildOptimization::debug};
  bool simd{false};
  bool kitty_graphics{false};
  bool tmux_control_mode{false};
};

// Build identity of the privately linked terminal engine. The version view has static lifetime.
[[nodiscard]] auto library_build_info() noexcept -> std::expected<LibraryBuildInfo, Error>;

enum class DirtyState : std::uint8_t {
  clean,
  partial,
  full,
};

enum class ScreenFormat : std::uint8_t {
  plain,
  vt,
  vt_full,
};

struct TerminalSize final {
  std::uint16_t columns{80};
  std::uint16_t rows{24};
  std::uint32_t cell_width_px{0};
  std::uint32_t cell_height_px{0};

  friend constexpr auto operator==(const TerminalSize&, const TerminalSize&) noexcept
      -> bool = default;
};

struct RgbColor final {
  std::uint8_t red{0};
  std::uint8_t green{0};
  std::uint8_t blue{0};

  friend constexpr auto operator==(const RgbColor&, const RgbColor&) noexcept -> bool = default;
};

struct TerminalTheme final {
  RgbColor foreground{};
  RgbColor background{};
  RgbColor cursor{};
  std::array<RgbColor, 256> palette{};

  friend constexpr auto operator==(const TerminalTheme&, const TerminalTheme&) noexcept
      -> bool = default;
};

// Returns the concrete xterm-compatible theme used when TerminalOptions::theme is unset.
[[nodiscard]] auto default_theme() noexcept -> TerminalTheme;

struct TerminalOptions final {
  TerminalSize size{};
  // Ghostty prunes scrollback at page granularity, so retained byte and line counts may exceed
  // their estimates. The limits are independent and the first one reached drives pruning.
  std::size_t scrollback_bytes_max{limits::terminal_scrollback_bytes_default};
  std::size_t allocation_bytes_max{limits::terminal_allocation_bytes_default};
  std::optional<TerminalTheme> theme;
  std::optional<std::size_t> scrollback_lines_max;
};

// Covers only allocations routed through Lemma's Ghostty C allocator. Ghostty PagePool storage and
// adapter-owned buffers such as physical cell hashes are excluded.
struct AllocationStats final {
  std::size_t bytes_current{0};
  std::size_t bytes_peak{0};
  std::size_t allocations_current{0};
  std::size_t allocations_total{0};
  std::size_t failures_total{0};
};

struct EffectBatch final {
  std::uint64_t bells{0};
  std::uint64_t title_changes{0};
  bool pty_response_overflowed{false};
};

struct AnsiRenderResult final {
  std::size_t bytes{0};
  std::size_t rows{0};
  std::int32_t scrolled_rows{0};
  bool full{false};
};

inline constexpr std::size_t pane_ansi_grapheme_bytes_max = 256;
// Per-cell allocation contract for a composed pane: one maximum grapheme, a 78-byte full SGR
// transition, a conservatively per-cell 14-byte absolute position (normally once per row), and the
// 4-byte reset emitted once per nonempty pane.
inline constexpr std::size_t pane_ansi_bytes_per_cell_max =
    pane_ansi_grapheme_bytes_max + 78U + 14U + 4U;

// Placement and outer-terminal policy for one surface in a composed frame. Coordinates are
// zero-based. The compositor, rather than the pane, owns synchronized-update framing and clearing.
struct PaneRenderOptions final {
  std::uint16_t column{0};
  std::uint16_t row{0};
  std::uint16_t cursor_override_column{0};
  std::uint16_t cursor_override_row{0};
  bool force_full{false};
  bool focused{false};
  bool cursor_override{false};
  bool allow_terminal_scroll{false};
};

enum class KeyAction : std::uint8_t {
  release,
  press,
  repeat,
};

enum class Key : std::uint8_t {
  unidentified,
  a,
  b,
  c,
  d,
  e,
  f,
  g,
  h,
  i,
  j,
  k,
  l,
  m,
  n,
  o,
  p,
  q,
  r,
  s,
  t,
  u,
  v,
  w,
  x,
  y,
  z,
  enter,
  tab,
  backspace,
  escape,
  space,
  arrow_up,
  arrow_down,
  arrow_left,
  arrow_right,
  home,
  end,
  insert,
  delete_key,
  page_up,
  page_down,
  f1,
  f2,
  f3,
  f4,
  f5,
  f6,
  f7,
  f8,
  f9,
  f10,
  f11,
  f12,
};

inline constexpr std::uint16_t key_modifier_shift = 1U << 0U;
inline constexpr std::uint16_t key_modifier_control = 1U << 1U;
inline constexpr std::uint16_t key_modifier_alt = 1U << 2U;
inline constexpr std::uint16_t key_modifier_super = 1U << 3U;

struct KeyEvent final {
  KeyAction action{KeyAction::press};
  Key key{Key::unidentified};
  std::uint16_t modifiers{0};
  std::uint16_t consumed_modifiers{0};
  std::uint32_t unshifted_codepoint{0};
  std::string_view text;
  bool composing{false};
};

struct RenderUpdate final {
  DirtyState dirty{DirtyState::clean};
  std::uint16_t columns{0};
  std::uint16_t rows{0};
  std::uint16_t cursor_column{0};
  std::uint16_t cursor_row{0};
  std::size_t dirty_rows{0};
  bool cursor_visible{false};
  bool cursor_in_viewport{false};
};

enum class PointSpace : std::uint8_t {
  active,
  viewport,
  screen,
  history,
};

struct TerminalPoint final {
  PointSpace space{PointSpace::viewport};
  std::uint16_t column{0};
  std::uint32_t row{0};

  friend constexpr auto operator==(const TerminalPoint&, const TerminalPoint&) noexcept
      -> bool = default;
};

enum class SelectionUnit : std::uint8_t {
  cell,
  word,
  line,
  output,
  all,
};

enum class SelectionAdjustment : std::uint8_t {
  left,
  right,
  up,
  down,
  home,
  end,
  page_up,
  page_down,
  beginning_of_line,
  end_of_line,
  word_left,
  word_right,
};

enum class SelectionGesturePhase : std::uint8_t {
  press,
  drag,
  release,
  autoscroll_tick,
  deep_press,
};

enum class SelectionAutoscroll : std::uint8_t {
  none,
  up,
  down,
};

struct SelectionGestureEvent final {
  SelectionGesturePhase phase{SelectionGesturePhase::press};
  TerminalPoint point{};
  double pointer_x{0};
  double pointer_y{0};
  std::uint32_t cell_width{1};
  std::uint32_t padding_left{0};
  std::uint32_t screen_height{1};
  std::uint64_t time_ns{0};
  std::uint64_t repeat_interval_ns{0};
  double repeat_distance{0};
  bool has_point{true};
  bool has_pointer_position{false};
  bool rectangle{false};
};

struct SelectionGestureResult final {
  SelectionAutoscroll autoscroll{SelectionAutoscroll::none};
  bool selection_changed{false};
  bool dragged{false};
};

enum class ViewportScroll : std::uint8_t {
  top,
  bottom,
  delta,
  row,
};

struct ViewportState final {
  std::uint64_t total_rows{0};
  std::uint64_t offset{0};
  std::uint64_t visible_rows{0};
  bool follows_output{true};
};

enum class CompressionResult : std::uint8_t {
  unsupported,
  pending,
  complete,
};

enum class SearchDirection : std::uint8_t {
  forward,
  backward,
};

struct SearchMatch final {
  TerminalPoint start{.space = PointSpace::screen};
  TerminalPoint end{.space = PointSpace::screen};

  friend constexpr auto operator==(const SearchMatch&, const SearchMatch&) noexcept
      -> bool = default;
};

enum class SearchStepStatus : std::uint8_t {
  found,
  pending,
  not_found,
};

// Caller-owned continuation for a bounded literal-search slice. The additional fields preserve a
// partially matched candidate while the search advances across blank cells and wrapped rows.
struct SearchCursor final {
  TerminalPoint candidate{.space = PointSpace::screen};
  TerminalPoint text{.space = PointSpace::screen};
  TerminalPoint match_end{.space = PointSpace::screen};
  std::size_t query_offset{0};
  bool matching{false};
};

struct SearchStepResult final {
  SearchStepStatus status{SearchStepStatus::not_found};
  SearchMatch match{};
  SearchCursor next{};
};

class Terminal final {
public:
  [[nodiscard]] static auto create(const TerminalOptions& options) noexcept
      -> std::expected<Terminal, Error>;

  Terminal(Terminal&& other) noexcept;
  auto operator=(Terminal&& other) noexcept -> Terminal&;

  Terminal(const Terminal&) = delete;
  auto operator=(const Terminal&) -> Terminal& = delete;

  ~Terminal();

  void write(std::span<const std::byte> bytes) noexcept;

  // Writes bytes exactly once and reports only render damage acquired from this write. Damage
  // already pending in the retained render snapshot is preserved but is not included in the
  // result. An error means damage inspection failed; the bytes have still been parsed.
  [[nodiscard]] auto write_and_report_damage(std::span<const std::byte> bytes) noexcept
      -> std::expected<DirtyState, Error>;

  [[nodiscard]] auto resize(const TerminalSize& size) noexcept -> std::expected<void, Error>;

  [[nodiscard]] auto update_render_state() noexcept -> std::expected<RenderUpdate, Error>;
  [[nodiscard]] auto mark_rendered() noexcept -> std::expected<void, Error>;

  // Incremental ANSI renderer for a terminal occupying the complete outer terminal.
  [[nodiscard]] auto render_ansi(std::span<std::byte> output, bool force_full = false) noexcept
      -> std::expected<AnsiRenderResult, Error>;

  // Incremental pane-surface encoder. It emits absolute positions offset by options, but no
  // synchronized-update boundary or screen clear, so a renderer can compose several panes into one
  // atomic outer-terminal frame.
  [[nodiscard]] auto render_pane_ansi(std::span<std::byte> output,
                                      const PaneRenderOptions& options) noexcept
      -> std::expected<AnsiRenderResult, Error>;

  // Invalidates retained ANSI output state after a composed frame is discarded.
  void invalidate_ansi_render_state() noexcept;

  // Encodes normalized input using the pane's active legacy or Kitty keyboard modes.
  [[nodiscard]] auto encode_key(const KeyEvent& event, std::span<std::byte> output) noexcept
      -> std::expected<std::size_t, Error>;

  // Encodes one opaque paste using Ghostty's filtering, newline, and bracketed-paste policy. The
  // input is mutable because Ghostty replaces unsafe control bytes in place.
  [[nodiscard]] auto encode_paste(std::span<std::byte> input, std::span<std::byte> output) noexcept
      -> std::expected<std::size_t, Error>;
  [[nodiscard]] auto paste_is_safe(std::span<const std::byte> input) const noexcept -> bool;

  // Canonical child mode used by the pane-owned presentation gate.
  [[nodiscard]] auto synchronized_output() const noexcept -> std::expected<bool, Error>;

  // Diagnostic formatter for tests, demos, and full-state fallback.
  [[nodiscard]] auto format_screen(ScreenFormat format, std::span<std::byte> output) noexcept
      -> std::expected<std::size_t, Error>;

  // Ghostty owns gesture interpretation and converts installed snapshots to tracked endpoints.
  // Lemma supplies presentation-space input and bounded caller-owned formatting storage.
  [[nodiscard]] auto selection_gesture(const SelectionGestureEvent& event) noexcept
      -> std::expected<SelectionGestureResult, Error>;
  void reset_selection_gesture() noexcept;
  [[nodiscard]] auto select(SelectionUnit unit, TerminalPoint point = {}) noexcept
      -> std::expected<bool, Error>;
  [[nodiscard]] auto selection_adjust(SelectionAdjustment adjustment, bool extend) noexcept
      -> std::expected<bool, Error>;
  [[nodiscard]] auto collapse_selection_to_endpoint() noexcept -> std::expected<bool, Error>;
  [[nodiscard]] auto selection_active() const noexcept -> std::expected<bool, Error>;
  [[nodiscard]] auto selection_endpoint(PointSpace space) const noexcept
      -> std::expected<std::optional<TerminalPoint>, Error>;
  // Reinstalls the terminal-owned selection from fresh snapshots after operations such as reflow.
  [[nodiscard]] auto refresh_selection() noexcept -> std::expected<bool, Error>;
  void clear_selection() noexcept;
  [[nodiscard]] auto format_selection(ScreenFormat format, std::span<std::byte> output) noexcept
      -> std::expected<std::size_t, Error>;

  void scroll_viewport(ViewportScroll behavior, std::int64_t value = 0) noexcept;
  [[nodiscard]] auto scroll_selection_into_view() noexcept -> std::expected<bool, Error>;
  [[nodiscard]] auto viewport_state() const noexcept -> std::expected<ViewportState, Error>;

  [[nodiscard]] auto compression_activity() const noexcept -> std::expected<std::uint64_t, Error>;
  [[nodiscard]] auto compress_scrollback() noexcept -> std::expected<CompressionResult, Error>;

  // Performs one bounded literal-search slice directly over Ghostty grid references. No terminal
  // text grid or match list is retained. The work limit charges every inspected cell or row, and a
  // pending result carries caller-owned continuation for a partially matched candidate.
  [[nodiscard]] auto
  search_literal_step(std::string_view query, SearchDirection direction,
                      std::optional<SearchCursor> start = std::nullopt,
                      std::size_t work_limit = limits::search_candidates_per_step) const noexcept
      -> std::expected<SearchStepResult, Error>;
  [[nodiscard]] auto select_search_match(const SearchMatch& match) noexcept
      -> std::expected<void, Error>;

  [[nodiscard]] auto size() const noexcept -> TerminalSize;
  [[nodiscard]] auto theme() const noexcept -> TerminalTheme;

  // The borrowed title remains valid only until the next terminal mutation.
  [[nodiscard]] auto title() const noexcept -> std::expected<std::string_view, Error>;
  [[nodiscard]] auto scrollback_rows() const noexcept -> std::expected<std::size_t, Error>;
  [[nodiscard]] auto take_effects() noexcept -> EffectBatch;

  [[nodiscard]] auto pending_pty_response_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto pty_response_overflowed() const noexcept -> bool;
  auto read_pty_responses(std::span<std::byte> output) noexcept -> std::size_t;

  [[nodiscard]] auto allocation_stats() const noexcept -> AllocationStats;

private:
  struct Impl;

  explicit Terminal(std::unique_ptr<Impl> impl) noexcept;

  [[nodiscard]] auto
  render_ansi_impl(std::span<std::byte> output, bool force_full, std::uint16_t origin_column,
                   std::uint16_t origin_row, bool composed, bool focused, bool cursor_override,
                   std::uint16_t cursor_override_column, std::uint16_t cursor_override_row,
                   bool allow_terminal_scroll) noexcept -> std::expected<AnsiRenderResult, Error>;

  std::unique_ptr<Impl> impl_;
};

} // namespace lemma::vt

#endif // LEMMA_TERMINAL_TERMINAL_HPP
