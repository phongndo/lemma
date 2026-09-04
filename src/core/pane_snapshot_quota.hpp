#ifndef LEMMA_CORE_PANE_SNAPSHOT_QUOTA_HPP
#define LEMMA_CORE_PANE_SNAPSHOT_QUOTA_HPP

#include "lemma/limits.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>

namespace lemma::core {

enum class PaneSnapshotQuotaError : std::uint8_t {
  invalid_request,
  capacity,
};

class PaneSnapshotQuota final {
public:
  class Reservation final {
  public:
    Reservation(Reservation&& other) noexcept;
    auto operator=(Reservation&& other) noexcept -> Reservation&;

    Reservation(const Reservation&) = delete;
    auto operator=(const Reservation&) -> Reservation& = delete;

    ~Reservation();

    [[nodiscard]] auto bytes() const noexcept -> std::size_t;
    [[nodiscard]] auto valid() const noexcept -> bool;

  private:
    friend class PaneSnapshotQuota;
    Reservation(PaneSnapshotQuota& owner, std::size_t session_slot, std::size_t bytes) noexcept;
    void reset() noexcept;

    PaneSnapshotQuota* owner_{nullptr};
    std::size_t session_slot_{0};
    std::size_t bytes_{0};
  };

  [[nodiscard]] auto reserve(std::size_t session_slot, std::size_t bytes) noexcept
      -> std::expected<Reservation, PaneSnapshotQuotaError>;

  [[nodiscard]] auto daemon_bytes() const noexcept -> std::size_t;
  [[nodiscard]] auto session_bytes(std::size_t session_slot) const noexcept -> std::size_t;

private:
  friend class Reservation;
  void release(std::size_t session_slot, std::size_t bytes) noexcept;

  std::array<std::size_t, limits::sessions_hard_max> session_bytes_{};
  std::size_t daemon_bytes_{0};
};

} // namespace lemma::core

#endif // LEMMA_CORE_PANE_SNAPSHOT_QUOTA_HPP
