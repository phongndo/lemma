#ifndef FIBER_RENDER_SINGLE_PANE_HPP
#define FIBER_RENDER_SINGLE_PANE_HPP

#include "fiber/terminal/terminal.hpp"
#include "render/pane_composition.hpp"

#include <array>
#include <cstddef>

namespace fiber::render {

inline constexpr std::size_t frame_bytes_max = std::size_t{4} * 1'024U * 1'024U;
using FrameBuffer = std::array<std::byte, frame_bytes_max>;

struct ClientOutputState final {
  std::size_t size{0};
  std::size_t offset{0};

  [[nodiscard]] auto busy() const noexcept -> bool { return offset < size; }
  void reset() noexcept {
    size = 0;
    offset = 0;
  }
};

// Initial attach and live updates share the same bounded partial-write state.
[[nodiscard]] auto flush_frame(int client, const FrameBuffer& frame,
                               ClientOutputState& output) noexcept -> bool;
[[nodiscard]] auto queue_frame(int client, vt::Terminal& terminal, FrameBuffer& frame,
                               ClientOutputState& output) noexcept -> bool;

[[nodiscard]] auto queue_composed_frame(int client, std::span<const PaneSurface> panes,
                                        Viewport viewport, FrameBuffer& frame,
                                        ClientOutputState& output, bool force_full,
                                        StatusLine status = {}) noexcept -> bool;

} // namespace fiber::render

#endif // FIBER_RENDER_SINGLE_PANE_HPP
