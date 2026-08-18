#include "core/client_frame_output.hpp"
#include "input/input_router.hpp"
#include "lemma/terminal/terminal.hpp"
#include "render/frame_buffer.hpp"

#include <array>
#include <atomic>
#include <cerrno>
#include <cstddef>
#include <cstdlib>
#include <new>
#include <print>
#include <span>
#include <string_view>
#include <utility>

namespace {

std::atomic<bool> audit_enabled{false};
std::atomic<std::size_t> audited_allocations{0};
std::atomic<std::size_t> audited_bytes{0};

void record_allocation(const std::size_t bytes) noexcept {
  if (audit_enabled.load(std::memory_order_relaxed)) {
    audited_allocations.fetch_add(1, std::memory_order_relaxed);
    audited_bytes.fetch_add(bytes, std::memory_order_relaxed);
  }
}

[[nodiscard]] auto allocate_unaligned(const std::size_t bytes) -> void* {
  const auto requested = bytes == 0 ? std::size_t{1} : bytes;
  // Global allocation replacement must delegate below the C++ allocation layer.
  // NOLINTNEXTLINE(cppcoreguidelines-no-malloc)
  void* const storage = std::malloc(requested);
  if (storage == nullptr) {
    throw std::bad_alloc{};
  }
  record_allocation(requested);
  return storage;
}

[[nodiscard]] auto allocate_aligned(const std::size_t bytes, const std::size_t alignment) -> void* {
  const auto requested = bytes == 0 ? std::size_t{1} : bytes;
  void* storage = nullptr;
  if (::posix_memalign(&storage, alignment, requested) != 0) {
    throw std::bad_alloc{};
  }
  record_allocation(requested);
  return storage;
}

[[nodiscard]] auto audited_write(void* const context,
                                 const std::span<const std::byte> bytes) noexcept
    -> lemma::core::ClientFrameWriteAttempt {
  *static_cast<std::size_t*>(context) += bytes.size();
  return {.bytes = static_cast<std::ptrdiff_t>(bytes.size())};
}

[[nodiscard]] auto write_and_compose(lemma::vt::Terminal& terminal,
                                     lemma::render::FrameBuffer& frame,
                                     const std::string_view text) noexcept -> std::size_t {
  const auto input = std::as_bytes(std::span(text.data(), text.size()));
  const auto damage = terminal.write_and_report_damage(input);
  if (!damage.has_value()) {
    return 0;
  }
  const auto composition = lemma::render::compose_retained_single_pane(terminal, frame, false);
  return composition.has_value() ? composition->bytes : 0;
}

} // namespace

// Define every replaceable throwing allocation and deallocation form. ASan observes sized
// deallocation before runtime delegation, so each form must pair directly with the malloc-backed
// audit allocator. This target enables the compiler's sized-deallocation language mode.
// NOLINTBEGIN(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp,cppcoreguidelines-no-malloc,readability-identifier-naming)
void* operator new(std::size_t __sz) { return allocate_unaligned(__sz); }
void* operator new[](std::size_t __sz) { return allocate_unaligned(__sz); }
void* operator new(std::size_t __sz, std::align_val_t alignment) {
  return allocate_aligned(__sz, static_cast<std::size_t>(alignment));
}
void* operator new[](std::size_t __sz, std::align_val_t alignment) {
  return allocate_aligned(__sz, static_cast<std::size_t>(alignment));
}
void operator delete(void* __p) noexcept { std::free(__p); }
void operator delete[](void* __p) noexcept { std::free(__p); }
void operator delete(void* __p, std::size_t /*size*/) noexcept { std::free(__p); }
void operator delete[](void* __p, std::size_t /*size*/) noexcept { std::free(__p); }
void operator delete(void* __p, std::align_val_t /*alignment*/) noexcept { std::free(__p); }
void operator delete[](void* __p, std::align_val_t /*alignment*/) noexcept { std::free(__p); }
void operator delete(void* __p, std::size_t /*size*/, std::align_val_t /*alignment*/) noexcept {
  std::free(__p);
}
void operator delete[](void* __p, std::size_t /*size*/, std::align_val_t /*alignment*/) noexcept {
  std::free(__p);
}
// NOLINTEND(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp,cppcoreguidelines-no-malloc,readability-identifier-naming)

// The explicit failure branches make audit setup and each measured operation independently visible;
// output formatting runs only after measurement is disabled and can report allocation failure.
// NOLINTNEXTLINE(bugprone-exception-escape,readability-function-cognitive-complexity)
int main() {
  constexpr std::size_t warmup_iterations = 256;
  constexpr std::size_t audited_iterations = 10'000;
  constexpr std::string_view first = "\x1B[12;1H\x1B[1;32msteady-state alpha \xE2\x98\x83\x1B[0m";
  constexpr std::string_view second = "\x1B[12;1H\x1B[1;34msteady-state beta  \xE2\x98\x83\x1B[0m";

  lemma::input::InputRouter input_router(lemma::input::default_input_map());
  constexpr std::array routed_input{std::byte{'a'}};
  auto terminal_result = lemma::vt::Terminal::create({});
  if (!terminal_result.has_value()) {
    return 2;
  }
  auto terminal = std::move(*terminal_result);
  lemma::render::FrameBuffer frame;
  if (!frame.prepare({.columns = 80, .rows = 24}) ||
      !lemma::render::compose_retained_single_pane(terminal, frame, true).has_value()) {
    return 2;
  }
  auto resize_terminal_result = lemma::vt::Terminal::create({});
  if (!resize_terminal_result.has_value()) {
    return 2;
  }
  auto resize_terminal = std::move(*resize_terminal_result);
  if (!resize_terminal.resize({.columns = 81, .rows = 24}).has_value()) {
    return 2;
  }
  for (std::size_t iteration = 0; iteration < warmup_iterations; ++iteration) {
    const auto routed = input_router.route_legacy(routed_input, routed_input.size());
    const auto bytes = write_and_compose(terminal, frame, iteration % 2U == 0 ? first : second);
    const lemma::vt::TerminalSize resize = iteration % 2U == 0
                                               ? lemma::vt::TerminalSize{.columns = 100, .rows = 24}
                                               : lemma::vt::TerminalSize{.columns = 80, .rows = 24};
    if (routed.consumed != routed_input.size() || bytes == 0 ||
        !resize_terminal.resize(resize).has_value()) {
      return 2;
    }
  }

  const auto terminal_before = terminal.allocation_stats();
  const auto resize_terminal_before = resize_terminal.allocation_stats();
  audited_allocations.store(0, std::memory_order_relaxed);
  audited_bytes.store(0, std::memory_order_relaxed);
  audit_enabled.store(true, std::memory_order_release);

  std::size_t flushed_bytes = 0;
  for (std::size_t iteration = 0; iteration < audited_iterations; ++iteration) {
    const auto routed = input_router.route_legacy(routed_input, routed_input.size());
    const auto frame_bytes =
        write_and_compose(terminal, frame, iteration % 2U == 0 ? first : second);
    const lemma::vt::TerminalSize resize = iteration % 2U == 0
                                               ? lemma::vt::TerminalSize{.columns = 100, .rows = 24}
                                               : lemma::vt::TerminalSize{.columns = 80, .rows = 24};
    if (routed.consumed != routed_input.size() || frame_bytes == 0 ||
        !resize_terminal.resize(resize).has_value()) {
      audit_enabled.store(false, std::memory_order_release);
      return 2;
    }
    lemma::core::ClientFrameOutput output;
    constexpr auto now = lemma::core::ClientFrameOutput::TimePoint{};
    if (!output.queue_frame(frame_bytes, 2, 1, false, now)) {
      audit_enabled.store(false, std::memory_order_release);
      return 2;
    }
    lemma::core::ClientFrameFlushTarget target{
        .descriptor = 7,
        .frame = &frame,
        .output = &output,
        .write = &audited_write,
        .context = &flushed_bytes,
    };
    std::size_t budget = lemma::core::attached_client_write_bytes_per_turn_max;
    if (lemma::core::flush_client_frame(target, budget, now) !=
        lemma::core::ClientFrameFlushStatus::drained) {
      audit_enabled.store(false, std::memory_order_release);
      return 2;
    }
  }
  audit_enabled.store(false, std::memory_order_release);

  const auto terminal_after = terminal.allocation_stats();
  const auto resize_terminal_after = resize_terminal.allocation_stats();
  const auto general_allocations = audited_allocations.load(std::memory_order_relaxed);
  const auto general_bytes = audited_bytes.load(std::memory_order_relaxed);
  const auto terminal_allocations =
      (terminal_after.allocations_total - terminal_before.allocations_total) +
      (resize_terminal_after.allocations_total - resize_terminal_before.allocations_total);
  const bool passed = general_allocations == 0 && general_bytes == 0 && terminal_allocations == 0;
  std::println(R"({{
  "schema": 1,
  "suite": "steady-state-allocation-audit",
  "status": "{}",
  "warmup_iterations": {},
  "audited_iterations": {},
  "terminal_resize_iterations": {},
  "general_allocation_calls": {},
  "general_allocation_bytes": {},
  "terminal_quota_allocation_calls": {},
  "flushed_wire_bytes": {}
}})",
               passed ? "passed" : "failed", warmup_iterations, audited_iterations,
               audited_iterations, general_allocations, general_bytes, terminal_allocations,
               flushed_bytes);
  return passed ? 0 : 1;
}
