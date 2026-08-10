#include "render/single_pane.hpp"

#include "render/pane_composition.hpp"

#include <span>

namespace lemma::render {

[[nodiscard]] auto compose_retained_frame(const std::span<const PaneSurface> panes,
                                          const Viewport viewport, FrameBuffer& frame,
                                          const bool force_full, const StatusLine status) noexcept
    -> std::expected<CompositionResult, CompositionError> {
  return compose_frame(panes, viewport, frame, force_full, status);
}

[[nodiscard]] auto compose_retained_single_pane(vt::Terminal& terminal, FrameBuffer& frame,
                                                const bool force_full) noexcept
    -> std::expected<CompositionResult, CompositionError> {
  const auto size = terminal.size();
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = size.columns, .rows = size.rows},
      .focused = true,
  };
  return compose_retained_frame(std::span(&pane, 1), {.columns = size.columns, .rows = size.rows},
                                frame, force_full);
}

} // namespace lemma::render
