#ifndef LEMMA_ID_HPP
#define LEMMA_ID_HPP

#include "lemma/assert.hpp"

#include <cstdint>
#include <limits>
#include <optional>

namespace lemma {

template <typename Tag> class GenerationalId final {
public:
  constexpr GenerationalId() noexcept = default;

  [[nodiscard]] static constexpr std::optional<GenerationalId>
  try_from_parts(const std::uint32_t slot, const std::uint32_t generation) noexcept {
    if (slot == invalid_slot || generation == 0) {
      return std::nullopt;
    }
    return GenerationalId(slot, generation);
  }

  [[nodiscard]] static constexpr GenerationalId
  from_parts(const std::uint32_t slot, const std::uint32_t generation) noexcept {
    const std::optional<GenerationalId> id = try_from_parts(slot, generation);
    LEMMA_ASSERT(id.has_value());
    return *id;
  }

  [[nodiscard]] constexpr bool is_valid() const noexcept {
    return slot_ != invalid_slot && generation_ != 0;
  }

  [[nodiscard]] constexpr std::uint32_t slot() const noexcept { return slot_; }
  [[nodiscard]] constexpr std::uint32_t generation() const noexcept { return generation_; }

  friend constexpr bool operator==(const GenerationalId&, const GenerationalId&) noexcept = default;

private:
  static constexpr std::uint32_t invalid_slot = std::numeric_limits<std::uint32_t>::max();

  constexpr GenerationalId(const std::uint32_t slot, const std::uint32_t generation) noexcept
      : slot_(slot), generation_(generation) {}

  std::uint32_t slot_{invalid_slot};
  std::uint32_t generation_{0};
};

struct SpaceIdTag final {};
struct WindowIdTag final {};
struct PaneIdTag final {};
struct ClientIdTag final {};

using SpaceId = GenerationalId<SpaceIdTag>;
using WindowId = GenerationalId<WindowIdTag>;
using PaneId = GenerationalId<PaneIdTag>;
using ClientId = GenerationalId<ClientIdTag>;

} // namespace lemma

#endif // LEMMA_ID_HPP
