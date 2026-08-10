#ifndef LEMMA_RENDER_SINGLE_PANE_HPP
#define LEMMA_RENDER_SINGLE_PANE_HPP

#include "lemma/terminal/terminal.hpp"
#include "render/pane_composition.hpp"

#include <array>
#include <cstddef>
#include <expected>
#include <span>

namespace lemma::render {

inline constexpr std::size_t frame_bytes_max = std::size_t{4} * 1'024U * 1'024U;
using FrameBuffer = std::array<std::byte, frame_bytes_max>;

// Composition only fills one retained bounded frame. Descriptor progress is owned by the core.
[[nodiscard]] auto compose_retained_frame(std::span<const PaneSurface> panes, Viewport viewport,
                                          FrameBuffer& frame, bool force_full,
                                          StatusLine status = {}) noexcept
    -> std::expected<CompositionResult, CompositionError>;

[[nodiscard]] auto compose_retained_single_pane(vt::Terminal& terminal, FrameBuffer& frame,
                                                bool force_full = false) noexcept
    -> std::expected<CompositionResult, CompositionError>;

} // namespace lemma::render

#endif // LEMMA_RENDER_SINGLE_PANE_HPP
