#include "lemma/command.hpp"
#include "lemma/lemma.hpp"
#include "lemma/terminal/terminal.hpp"
#include "protocol/attachment.hpp"
#include "protocol/extension.hpp"
#include "render/pane_composition.hpp"

#include <benchmark/benchmark.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef __APPLE__
#include <sys/sysctl.h>
#endif

namespace lemma {
namespace {

void benchmark_greeting(benchmark::State& state) {
  for ([[maybe_unused]] const auto iteration : state) {
    benchmark::DoNotOptimize(greeting());
  }
}

struct CommandBenchmarkContext final {
  std::uint64_t calls{0};
};

[[nodiscard]] auto execute_benchmark_command(void* const context,
                                             const Command& /*command*/) noexcept -> CommandResult {
  ++static_cast<CommandBenchmarkContext*>(context)->calls;
  return {.status = CommandStatus::applied};
}

void benchmark_command_dispatch(benchmark::State& state) {
  CommandBenchmarkContext context;
  const CommandDispatcher dispatcher(&execute_benchmark_command, &context);
  const Command command{.kind = CommandKind::focus_next, .origin = CommandOrigin::keymap};
  for ([[maybe_unused]] const auto iteration : state) {
    auto status = dispatcher.dispatch(command).status;
    benchmark::DoNotOptimize(status);
  }
  benchmark::DoNotOptimize(context.calls);
}

void benchmark_extension_registration_codec(benchmark::State& state) {
  std::array<std::byte, 512> frame{};
  for ([[maybe_unused]] const auto iteration : state) {
    const auto encoded = protocol::extension::encode_command(
        {.name = "agents.toggle", .description = "Toggle the agent sidebar"}, 42, frame);
    if (!encoded.has_value()) {
      state.SkipWithError("failed to encode extension registration");
      return;
    }
    protocol::extension::Decoder decoder;
    std::ranges::copy(std::span(frame).first(*encoded), decoder.writable_bytes().begin());
    if (!decoder.commit(*encoded).has_value()) {
      state.SkipWithError("failed to commit extension frame");
      return;
    }
    const auto message = decoder.next();
    if (!message.has_value() || !message->has_value()) {
      state.SkipWithError("failed to decode extension frame");
      return;
    }
    const auto registration = protocol::extension::decode_command(**message);
    if (!registration.has_value()) {
      state.SkipWithError("failed to decode extension registration");
      return;
    }
    auto registration_value = *registration;
    benchmark::DoNotOptimize(registration_value);
  }
}

void benchmark_private_attach_input_codec(benchmark::State& state) {
  constexpr std::array payload{std::byte{'i'}, std::byte{'n'}, std::byte{'p'}, std::byte{'u'},
                               std::byte{'t'}};
  const auto header = protocol::encode_input_header(payload.size(), 2);
  protocol::ClientDecoder decoder;
  if (!decoder.prepare().has_value()) {
    state.SkipWithError("failed to prepare private attach decoder");
    return;
  }
  for ([[maybe_unused]] const auto iteration : state) {
    decoder.reset(2, false);
    auto destination = std::ranges::copy(header, decoder.writable_bytes().begin()).out;
    std::ranges::copy(payload, destination);
    if (!decoder.commit(header.size() + payload.size()).has_value()) {
      state.SkipWithError("failed to commit private attach frame");
      return;
    }
    const auto decoded = decoder.next();
    if (!decoded.has_value() || !decoded->has_value()) {
      state.SkipWithError("failed to decode private attach frame");
      return;
    }
    auto message = **decoded;
    benchmark::DoNotOptimize(message);
    decoder.consume();
  }
  state.counters["wire_overhead_bytes"] = static_cast<double>(protocol::attach_header_bytes);
}

void benchmark_terminal_small_writes(benchmark::State& state) {
  auto result = vt::Terminal::create({});
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  constexpr std::string_view input = "prompt> echo hello\r\n";
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));

  for ([[maybe_unused]] const auto iteration : state) {
    terminal.write(bytes);
    benchmark::ClobberMemory();
  }
  state.SetBytesProcessed(state.iterations() * static_cast<std::int64_t>(bytes.size()));
}

void benchmark_terminal_large_writes(benchmark::State& state) {
  auto result = vt::Terminal::create({});
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  std::array<std::byte, std::size_t{64} * 1'024U> input{};
  input.fill(std::byte{'x'});

  for ([[maybe_unused]] const auto iteration : state) {
    terminal.write(input);
    benchmark::ClobberMemory();
  }
  state.SetBytesProcessed(state.iterations() * static_cast<std::int64_t>(input.size()));
}

void benchmark_terminal_render_updates(benchmark::State& state) {
  auto result = vt::Terminal::create({});
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  constexpr std::string_view input = "changed row\r\n";
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));

  for ([[maybe_unused]] const auto iteration : state) {
    terminal.write(bytes);
    auto update = terminal.update_render_state();
    benchmark::DoNotOptimize(update);
    if (!update.has_value() || !terminal.mark_rendered().has_value()) {
      state.SkipWithError("failed to update render state");
      break;
    }
  }
}

void benchmark_terminal_ansi_damage_frames(benchmark::State& state) {
  auto result = vt::Terminal::create({});
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  constexpr std::string_view input = "changed row with styled \x1B[1;32mcontent\x1B[0m\r\n";
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));
  std::array<std::byte, std::size_t{256} * 1'024U> frame{};
  auto initial = terminal.render_ansi(frame, true);
  if (!initial.has_value()) {
    state.SkipWithError("failed to render initial frame");
    return;
  }
  std::uint64_t output_bytes = 0;

  for ([[maybe_unused]] const auto iteration : state) {
    terminal.write(bytes);
    auto rendered = terminal.render_ansi(frame);
    benchmark::DoNotOptimize(rendered);
    if (!rendered.has_value()) {
      state.SkipWithError("failed to render ANSI damage");
      break;
    }
    output_bytes += rendered->bytes;
  }
  state.counters["frame_bytes"] =
      benchmark::Counter(static_cast<double>(output_bytes), benchmark::Counter::kAvgIterations);
}

void benchmark_terminal_ansi_single_row(benchmark::State& state) {
  auto result = vt::Terminal::create({});
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  constexpr std::string_view first = "\x1B[10;1Hfirst styled \x1B[1;32mrow\x1B[0m";
  constexpr std::string_view second = "\x1B[10;1Hsecond styled \x1B[1;34mrow\x1B[0m";
  std::array<std::byte, std::size_t{256} * 1'024U> frame{};
  auto initial = terminal.render_ansi(frame, true);
  if (!initial.has_value()) {
    state.SkipWithError("failed to render initial frame");
    return;
  }
  std::uint64_t output_bytes = 0;
  bool use_first = false;

  for ([[maybe_unused]] const auto iteration : state) {
    const auto input = use_first ? first : second;
    use_first = !use_first;
    terminal.write(std::as_bytes(std::span(input.data(), input.size())));
    auto rendered = terminal.render_ansi(frame);
    benchmark::DoNotOptimize(rendered);
    if (!rendered.has_value()) {
      state.SkipWithError("failed to render ANSI row");
      break;
    }
    output_bytes += rendered->bytes;
  }
  state.counters["frame_bytes"] =
      benchmark::Counter(static_cast<double>(output_bytes), benchmark::Counter::kAvgIterations);
}

void benchmark_terminal_ansi_scroll_operations(benchmark::State& state) {
  vt::TerminalOptions options;
  options.size = {.columns = 80, .rows = 24};
  auto result = vt::Terminal::create(options);
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  std::array<std::byte, std::size_t{256} * 1'024U> frame{};
  constexpr std::string_view initial =
      "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\r\n10\r\n11\r\n12\r\n"
      "13\r\n14\r\n15\r\n16\r\n17\r\n18\r\n19\r\n20\r\n21\r\n22\r\n23\r\n24";
  terminal.write(std::as_bytes(std::span(initial.data(), initial.size())));
  if (!terminal.render_ansi(frame, true).has_value()) {
    state.SkipWithError("failed to render initial frame");
    return;
  }
  std::uint64_t output_bytes = 0;

  for ([[maybe_unused]] const auto iteration : state) {
    constexpr std::string_view line = "\r\nnext scrolling row";
    terminal.write(std::as_bytes(std::span(line.data(), line.size())));
    const auto rendered = terminal.render_ansi(frame);
    if (!rendered.has_value() || rendered->scrolled_rows != 1) {
      state.SkipWithError("failed to encode scroll operation");
      break;
    }
    output_bytes += rendered->bytes;
  }
  state.counters["frame_bytes"] =
      benchmark::Counter(static_cast<double>(output_bytes), benchmark::Counter::kAvgIterations);
}

void benchmark_terminal_multiple_panes(benchmark::State& state) {
  const auto pane_count = static_cast<std::size_t>(state.range(0));
  std::size_t grid_columns = 8;
  if (pane_count == 1) {
    grid_columns = 1;
  } else if (pane_count == 4) {
    grid_columns = 2;
  } else if (pane_count == 16) {
    grid_columns = 4;
  }
  const auto grid_rows = pane_count / grid_columns;
  constexpr std::uint16_t viewport_columns = 240;
  constexpr std::uint16_t viewport_rows = 80;
  const auto pane_columns = static_cast<std::uint16_t>(viewport_columns / grid_columns);
  const auto pane_rows = static_cast<std::uint16_t>(viewport_rows / grid_rows);
  std::vector<vt::Terminal> terminals;
  terminals.reserve(pane_count);
  vt::TerminalOptions options;
  options.size = {.columns = pane_columns, .rows = pane_rows};
  for (std::size_t pane = 0; pane < pane_count; ++pane) {
    auto result = vt::Terminal::create(options);
    if (!result.has_value()) {
      state.SkipWithError("failed to create terminal");
      return;
    }
    terminals.emplace_back(std::move(*result));
  }

  std::vector<render::PaneSurface> panes;
  panes.reserve(pane_count);
  for (std::size_t pane = 0; pane < pane_count; ++pane) {
    panes.push_back({
        .terminal = &std::span(terminals).subspan(pane, 1).front(),
        .rectangle =
            {
                .column = static_cast<std::uint16_t>((pane % grid_columns) * pane_columns),
                .row = static_cast<std::uint16_t>((pane / grid_columns) * pane_rows),
                .columns = pane_columns,
                .rows = pane_rows,
            },
        .focused = pane == 0,
    });
  }
  const render::Viewport viewport{.columns = viewport_columns, .rows = viewport_rows};
  std::array<std::byte, std::size_t{256} * 1'024U> frame{};
  constexpr std::string_view first = "\x1B[1;1HA";
  constexpr std::string_view second = "\x1B[1;1HB";
  if (!render::compose_frame(panes, viewport, frame, true).has_value()) {
    state.SkipWithError("failed to compose initial frame");
    return;
  }
  std::uint64_t output_bytes = 0;
  bool use_first = false;

  for ([[maybe_unused]] const auto iteration : state) {
    const auto input = use_first ? first : second;
    use_first = !use_first;
    const auto bytes = std::as_bytes(std::span(input.data(), input.size()));
    for (auto& terminal : terminals) {
      terminal.write(bytes);
    }
    auto rendered = render::compose_frame(panes, viewport, frame, false);
    benchmark::DoNotOptimize(rendered);
    if (!rendered.has_value()) {
      state.SkipWithError("failed to compose panes");
      return;
    }
    output_bytes += rendered->bytes;
  }
  state.counters["frame_bytes"] =
      benchmark::Counter(static_cast<double>(output_bytes), benchmark::Counter::kAvgIterations);
}

void benchmark_terminal_full_frames(benchmark::State& state) {
  auto result = vt::Terminal::create({});
  if (!result.has_value()) {
    state.SkipWithError("failed to create terminal");
    return;
  }
  auto terminal = std::move(result).value();
  constexpr std::string_view input = "changed row with styled \x1B[1;32mcontent\x1B[0m\r\n";
  const auto bytes = std::as_bytes(std::span(input.data(), input.size()));
  std::array<std::byte, std::size_t{256} * 1'024U> frame{};
  std::uint64_t output_bytes = 0;

  for ([[maybe_unused]] const auto iteration : state) {
    terminal.write(bytes);
    auto frame_size = terminal.format_screen(vt::ScreenFormat::vt_full, frame);
    benchmark::DoNotOptimize(frame_size);
    if (!frame_size.has_value()) {
      state.SkipWithError("failed to format full frame");
      break;
    }
    output_bytes += *frame_size;
  }
  state.counters["frame_bytes"] =
      benchmark::Counter(static_cast<double>(output_bytes), benchmark::Counter::kAvgIterations);
}

BENCHMARK(benchmark_greeting);
BENCHMARK(benchmark_command_dispatch);
BENCHMARK(benchmark_extension_registration_codec);
BENCHMARK(benchmark_private_attach_input_codec);
BENCHMARK(benchmark_terminal_small_writes);
BENCHMARK(benchmark_terminal_large_writes);
BENCHMARK(benchmark_terminal_render_updates);
BENCHMARK(benchmark_terminal_ansi_damage_frames);
BENCHMARK(benchmark_terminal_ansi_single_row);
BENCHMARK(benchmark_terminal_ansi_scroll_operations);
BENCHMARK(benchmark_terminal_multiple_panes)->Arg(1)->Arg(4)->Arg(16)->Arg(64);
BENCHMARK(benchmark_terminal_full_frames);

} // namespace
} // namespace lemma

namespace {

#ifdef __APPLE__
[[nodiscard]] auto sysctl_string(const char* const name) -> std::optional<std::string> {
  std::size_t size = 0;
  constexpr std::size_t value_bytes_max = 4'096;
  if (::sysctlbyname(name, nullptr, &size, nullptr, 0) != 0 || size == 0 ||
      size > value_bytes_max) {
    return std::nullopt;
  }
  std::string value(size, '\0');
  if (::sysctlbyname(name, value.data(), &size, nullptr, 0) != 0 || size == 0) {
    return std::nullopt;
  }
  value.resize(size);
  while (!value.empty() && value.back() == '\0') {
    value.pop_back();
  }
  return value.empty() ? std::nullopt : std::optional<std::string>{std::move(value)};
}

[[nodiscard]] auto sysctl_unsigned(const char* const name) -> std::optional<std::uint64_t> {
  std::uint64_t value = 0;
  std::size_t size = sizeof(value);
  if (::sysctlbyname(name, &value, &size, nullptr, 0) != 0 ||
      (size != sizeof(std::uint32_t) && size != sizeof(value))) {
    return std::nullopt;
  }
  return value;
}
#endif

void add_host_fingerprint_context() {
#ifdef __APPLE__
  const auto model = sysctl_string("hw.model");
  const auto cpu = sysctl_string("machdep.cpu.brand_string");
  const auto physical_cpus = sysctl_unsigned("hw.physicalcpu");
  const auto memory = sysctl_unsigned("hw.memsize");
  benchmark::AddCustomContext("host_model_identifier", model.value_or("unavailable"));
  benchmark::AddCustomContext("host_cpu_model", cpu.value_or("unavailable"));
  benchmark::AddCustomContext("host_physical_cpu_count", physical_cpus.has_value()
                                                             ? std::to_string(*physical_cpus)
                                                             : "unavailable");
  benchmark::AddCustomContext("host_memory_bytes",
                              memory.has_value() ? std::to_string(*memory) : "unavailable");
#else
  benchmark::AddCustomContext("host_model_identifier", "unavailable");
  benchmark::AddCustomContext("host_cpu_model", "unavailable");
  benchmark::AddCustomContext("host_physical_cpu_count", "unavailable");
  benchmark::AddCustomContext("host_memory_bytes", "unavailable");
#endif
}

} // namespace

int main(int argc, char** argv) {
  try {
    benchmark::Initialize(&argc, argv);
    if (benchmark::ReportUnrecognizedArguments(argc, argv)) {
      return 1;
    }
    add_host_fingerprint_context();
    static_cast<void>(benchmark::RunSpecifiedBenchmarks());
    benchmark::Shutdown();
    return 0;
  } catch (...) {
    return 1;
  }
}
