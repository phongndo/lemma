#ifndef LEMMA_TERMINAL_TERMINAL_HPP
#define LEMMA_TERMINAL_TERMINAL_HPP

#include "lemma/limits.hpp"

#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
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
};

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

struct TerminalOptions final {
  TerminalSize size{};
  std::size_t scrollback_rows_max{limits::terminal_scrollback_rows_default};
  std::size_t allocation_bytes_max{limits::terminal_allocation_bytes_default};
};

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

// Placement and outer-terminal policy for one surface in a composed frame. Coordinates are
// zero-based. The compositor, rather than the pane, owns synchronized-update framing and clearing.
struct PaneRenderOptions final {
  std::uint16_t column{0};
  std::uint16_t row{0};
  bool force_full{false};
  bool focused{false};
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

  // Diagnostic formatter for tests, demos, and full-state fallback.
  [[nodiscard]] auto format_screen(ScreenFormat format, std::span<std::byte> output) noexcept
      -> std::expected<std::size_t, Error>;

  [[nodiscard]] auto size() const noexcept -> TerminalSize;

  // The borrowed title remains valid only until the next terminal mutation.
  [[nodiscard]] auto title() const noexcept -> std::expected<std::string_view, Error>;
  [[nodiscard]] auto take_effects() noexcept -> EffectBatch;

  [[nodiscard]] auto pending_pty_response_bytes() const noexcept -> std::size_t;
  auto read_pty_responses(std::span<std::byte> output) noexcept -> std::size_t;

  [[nodiscard]] auto allocation_stats() const noexcept -> AllocationStats;

private:
  struct Impl;

  explicit Terminal(std::unique_ptr<Impl> impl) noexcept;

  [[nodiscard]] auto render_ansi_impl(std::span<std::byte> output, bool force_full,
                                      std::uint16_t origin_column, std::uint16_t origin_row,
                                      bool composed, bool focused,
                                      bool allow_terminal_scroll) noexcept
      -> std::expected<AnsiRenderResult, Error>;

  std::unique_ptr<Impl> impl_;
};

} // namespace lemma::vt

#endif // LEMMA_TERMINAL_TERMINAL_HPP
