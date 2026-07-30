#include "render/single_pane.hpp"

#include "render/pane_composition.hpp"

#include "fiber/assert.hpp"

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <span>

#include <sys/socket.h>

namespace fiber::render {

[[nodiscard]] auto flush_frame(const int client, const FrameBuffer& frame,
                               ClientOutputState& output) noexcept -> bool {
  constexpr std::size_t bytes_per_turn_max = std::size_t{64} * 1'024U;
  constexpr std::size_t attempts_per_turn_max = 32;
  std::size_t budget = bytes_per_turn_max;
  std::size_t attempts = 0;
  while (output.busy() && budget > 0 && attempts < attempts_per_turn_max) {
    ++attempts;
    const auto remaining = std::span(frame).first(output.size).subspan(output.offset);
    const auto bytes = remaining.first(std::min(remaining.size(), budget));
    const auto sent = ::send(client, bytes.data(), bytes.size(), MSG_NOSIGNAL);
    if (sent > 0) {
      const auto size = static_cast<std::size_t>(sent);
      output.offset += size;
      budget -= size;
      continue;
    }
    if (sent < 0 && errno == EINTR) {
      continue;
    }
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return true;
    }
    return false;
  }
  if (!output.busy()) {
    output.reset();
  }
  return true;
}

[[nodiscard]] auto queue_composed_frame(const int client, const std::span<const PaneSurface> panes,
                                        const Viewport viewport, FrameBuffer& frame,
                                        ClientOutputState& output, const bool force_full,
                                        const StatusLine status) noexcept -> bool {
  FIBER_ASSERT(!output.busy());
  const auto rendered = compose_frame(panes, viewport, frame, force_full, status);
  if (!rendered.has_value()) {
    return false;
  }
  output.size = rendered->bytes;
  output.offset = 0;
  return flush_frame(client, frame, output);
}

[[nodiscard]] auto queue_frame(const int client, vt::Terminal& terminal, FrameBuffer& frame,
                               ClientOutputState& output) noexcept -> bool {
  const auto size = terminal.size();
  const PaneSurface pane{
      .terminal = &terminal,
      .rectangle = {.columns = size.columns, .rows = size.rows},
      .focused = true,
  };
  return queue_composed_frame(client, std::span(&pane, 1),
                              {.columns = size.columns, .rows = size.rows}, frame, output, false);
}

} // namespace fiber::render
