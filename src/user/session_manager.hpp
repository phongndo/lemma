#ifndef LEMMA_USER_SESSION_MANAGER_HPP
#define LEMMA_USER_SESSION_MANAGER_HPP

#include "api/json.hpp"

namespace lemma::user {
// Invocation-scoped user process; all state and interaction crosses the public extension protocol.
[[nodiscard]] auto run_session_manager(const api::JsonValue& context) -> int;
} // namespace lemma::user

#endif
