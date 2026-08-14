#ifndef LEMMA_RENDER_SINGLE_PANE_HPP
#define LEMMA_RENDER_SINGLE_PANE_HPP

#include "lemma/limits.hpp"
#include "lemma/terminal/terminal.hpp"
#include "render/pane_composition.hpp"

#include <cstddef>
#include <expected>
#include <memory>
#include <span>

namespace lemma::render {

inline constexpr std::size_t frame_bytes_max = limits::frame_chunk_bytes_max;
inline constexpr std::size_t frame_bytes_min = std::size_t{64} * 1'024U;
inline constexpr std::size_t frame_bytes_per_viewport_cell = vt::pane_ansi_bytes_per_cell_max;
// Covers outer synchronized-update framing, focused cursor/mode state, and compositor control
// bytes.
inline constexpr std::size_t frame_fixed_overhead_bytes = std::size_t{4} * 1'024U;

static_assert(frame_bytes_min < frame_bytes_max);
static_assert(frame_fixed_overhead_bytes < frame_bytes_min);

enum class FrameCapacityError : unsigned char {
  invalid_viewport,
  arithmetic_overflow,
};

[[nodiscard]] auto frame_capacity_for_viewport(Viewport viewport) noexcept
    -> std::expected<std::size_t, FrameCapacityError>;

// NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)
using FrameStorage = std::unique_ptr<std::byte[]>;
using FrameAllocationOperation = FrameStorage (*)(void* context, std::size_t bytes) noexcept;

// One explicit RAII owner for attached-client frame bytes. Capacity can change only when the core
// calls prepare() at attach or resize; composition and flushing receive non-owning spans.
class FrameBuffer final {
public:
  explicit FrameBuffer(FrameAllocationOperation allocate = nullptr,
                       void* allocation_context = nullptr) noexcept;

  FrameBuffer(const FrameBuffer&) = delete;
  auto operator=(const FrameBuffer&) -> FrameBuffer& = delete;
  FrameBuffer(FrameBuffer&&) = delete;
  auto operator=(FrameBuffer&&) -> FrameBuffer& = delete;
  ~FrameBuffer() = default;

  [[nodiscard]] auto prepare(Viewport viewport, std::size_t preserve_bytes = 0) noexcept -> bool;
  void release() noexcept;

  [[nodiscard]] auto writable() noexcept -> std::span<std::byte>;
  [[nodiscard]] auto readable(std::size_t bytes) const noexcept -> std::span<const std::byte>;
  [[nodiscard]] auto capacity() const noexcept -> std::size_t { return capacity_; }

private:
  FrameStorage storage_;
  std::size_t capacity_{0};
  FrameAllocationOperation allocate_{nullptr};
  void* allocation_context_{nullptr};
};

static_assert(sizeof(FrameBuffer) <= 4U * sizeof(void*));

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
