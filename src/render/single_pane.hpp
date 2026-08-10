#ifndef LEMMA_RENDER_SINGLE_PANE_HPP
#define LEMMA_RENDER_SINGLE_PANE_HPP

#include "lemma/terminal/terminal.hpp"
#include "render/pane_composition.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace lemma::render {

inline constexpr std::size_t frame_bytes_max = std::size_t{4} * 1'024U * 1'024U;
using FrameBuffer = std::array<std::byte, frame_bytes_max>;

struct ClientOutputState final {
  std::size_t size{0};
  std::size_t offset{0};
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  std::uint64_t latency_trace_correlation{0};
#endif

  [[nodiscard]] auto busy() const noexcept -> bool { return offset < size; }
#ifdef LEMMA_ENABLE_LATENCY_TRACE
  [[nodiscard]] auto trace_correlation() const noexcept -> std::uint64_t {
    return latency_trace_correlation;
  }
#endif
  void reset() noexcept {
    size = 0;
    offset = 0;
#ifdef LEMMA_ENABLE_LATENCY_TRACE
    latency_trace_correlation = 0;
#endif
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

} // namespace lemma::render

#endif // LEMMA_RENDER_SINGLE_PANE_HPP
