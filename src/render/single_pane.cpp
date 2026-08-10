#include "render/single_pane.hpp"

#include "render/pane_composition.hpp"

#include "lemma/limits.hpp"

#include <algorithm>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <span>

namespace lemma::render {
namespace {

[[nodiscard]] auto allocate_frame_storage(void* const /*context*/, const std::size_t bytes) noexcept
    -> FrameStorage {
  try {
    // Runtime-sized frame storage cannot use std::array.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
    return std::make_unique_for_overwrite<std::byte[]>(bytes);
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
}

} // namespace

[[nodiscard]] auto frame_capacity_for_viewport(const Viewport viewport) noexcept
    -> std::expected<std::size_t, FrameCapacityError> {
  if (viewport.columns == 0 || viewport.rows == 0 ||
      viewport.columns > limits::terminal_columns_hard_max ||
      viewport.rows > limits::terminal_rows_hard_max) {
    return std::unexpected(FrameCapacityError::invalid_viewport);
  }
  const auto columns = static_cast<std::size_t>(viewport.columns);
  const auto rows = static_cast<std::size_t>(viewport.rows);
  if (columns > std::numeric_limits<std::size_t>::max() / rows) {
    return std::unexpected(FrameCapacityError::arithmetic_overflow);
  }
  const auto cells = columns * rows;
  constexpr auto variable_bytes_max =
      std::numeric_limits<std::size_t>::max() - frame_fixed_overhead_bytes;
  if (cells > variable_bytes_max / frame_bytes_per_viewport_cell) {
    return std::unexpected(FrameCapacityError::arithmetic_overflow);
  }
  const auto calculated = frame_fixed_overhead_bytes + (cells * frame_bytes_per_viewport_cell);
  return std::min(frame_bytes_max, std::max(frame_bytes_min, calculated));
}

FrameBuffer::FrameBuffer(const FrameAllocationOperation allocate,
                         void* const allocation_context) noexcept
    : allocate_(allocate == nullptr ? &allocate_frame_storage : allocate),
      allocation_context_(allocation_context) {}

[[nodiscard]] auto FrameBuffer::prepare(const Viewport viewport,
                                        const std::size_t preserve_bytes) noexcept -> bool {
  const auto required = frame_capacity_for_viewport(viewport);
  if (!required.has_value() || preserve_bytes > capacity_) {
    return false;
  }
  if (*required <= capacity_) {
    return true;
  }
  auto replacement = allocate_(allocation_context_, *required);
  if (replacement == nullptr) {
    return false;
  }
  if (preserve_bytes > 0) {
    std::memcpy(replacement.get(), storage_.get(), preserve_bytes);
  }
  storage_ = std::move(replacement);
  capacity_ = *required;
  return true;
}

void FrameBuffer::release() noexcept {
  storage_.reset();
  capacity_ = 0;
}

[[nodiscard]] auto FrameBuffer::writable() noexcept -> std::span<std::byte> {
  return storage_ == nullptr ? std::span<std::byte>{}
                             : std::span<std::byte>(storage_.get(), capacity_);
}

[[nodiscard]] auto FrameBuffer::readable(const std::size_t bytes) const noexcept
    -> std::span<const std::byte> {
  if (storage_ == nullptr || bytes > capacity_) {
    return {};
  }
  return std::span<const std::byte>(storage_.get(), capacity_).first(bytes);
}

[[nodiscard]] auto compose_retained_frame(const std::span<const PaneSurface> panes,
                                          const Viewport viewport, FrameBuffer& frame,
                                          const bool force_full, const StatusLine status) noexcept
    -> std::expected<CompositionResult, CompositionError> {
  return compose_frame(panes, viewport, frame.writable(), force_full, status);
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
