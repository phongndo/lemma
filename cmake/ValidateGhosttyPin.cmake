if(NOT DEFINED GHOSTTY_PIN_FILE OR NOT DEFINED GHOSTTY_SOURCE_DIR)
  message(FATAL_ERROR "Ghostty pin validation requires pin and source paths")
endif()
if(NOT EXISTS "${GHOSTTY_PIN_FILE}")
  message(FATAL_ERROR "missing Ghostty pin metadata: ${GHOSTTY_PIN_FILE}")
endif()

file(READ "${GHOSTTY_PIN_FILE}" ghostty_pin_json)
string(JSON ghostty_pinned_commit GET "${ghostty_pin_json}" commit)

# Flake inputs have no .git directory. Their locked revision and NAR hash make the source immutable,
# so accept that attestation only for a source already copied into the Nix store.
if(DEFINED GHOSTTY_NIX_SOURCE_REV AND NOT GHOSTTY_NIX_SOURCE_REV STREQUAL "")
  if(NOT GHOSTTY_SOURCE_DIR MATCHES "^/nix/store/")
    message(FATAL_ERROR "an attested Ghostty source must reside in /nix/store")
  endif()
  if(NOT GHOSTTY_NIX_SOURCE_REV STREQUAL ghostty_pinned_commit)
    message(FATAL_ERROR
      "Ghostty flake input mismatch: PIN.json requires ${ghostty_pinned_commit}, found ${GHOSTTY_NIX_SOURCE_REV}"
    )
  endif()
  if(NOT EXISTS "${GHOSTTY_SOURCE_DIR}/build.zig")
    message(FATAL_ERROR "attested Ghostty source is missing build.zig: ${GHOSTTY_SOURCE_DIR}")
  endif()
  return()
endif()

if(NOT DEFINED GHOSTTY_GIT_EXECUTABLE)
  message(FATAL_ERROR "a non-Nix Ghostty source requires Git validation")
endif()
# An uninitialized submodule is an empty directory. Git then walks up to Lemma and
# reports the parent HEAD, which looks like a pin mismatch instead of a missing checkout.
if(NOT EXISTS "${GHOSTTY_SOURCE_DIR}/.git" OR NOT EXISTS "${GHOSTTY_SOURCE_DIR}/build.zig")
  message(FATAL_ERROR
    "Ghostty submodule is not initialized at ${GHOSTTY_SOURCE_DIR}; run: git submodule update --init --depth 1 third_party/ghostty"
  )
endif()
execute_process(
  COMMAND "${GHOSTTY_GIT_EXECUTABLE}" rev-parse --show-toplevel
  WORKING_DIRECTORY "${GHOSTTY_SOURCE_DIR}"
  RESULT_VARIABLE ghostty_toplevel_result
  OUTPUT_VARIABLE ghostty_toplevel
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
file(REAL_PATH "${GHOSTTY_SOURCE_DIR}" ghostty_source_real)
if(NOT ghostty_toplevel_result EQUAL 0)
  message(FATAL_ERROR "Ghostty source is not a Git checkout: ${GHOSTTY_SOURCE_DIR}")
endif()
file(REAL_PATH "${ghostty_toplevel}" ghostty_toplevel_real)
if(NOT ghostty_source_real STREQUAL ghostty_toplevel_real)
  message(FATAL_ERROR
    "Ghostty submodule is not initialized at ${GHOSTTY_SOURCE_DIR}; run: git submodule update --init --depth 1 third_party/ghostty"
  )
endif()
execute_process(
  COMMAND "${GHOSTTY_GIT_EXECUTABLE}" rev-parse HEAD
  WORKING_DIRECTORY "${GHOSTTY_SOURCE_DIR}"
  RESULT_VARIABLE ghostty_git_result
  OUTPUT_VARIABLE ghostty_actual_commit
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT ghostty_git_result EQUAL 0 OR
   NOT ghostty_actual_commit STREQUAL ghostty_pinned_commit)
  message(FATAL_ERROR
    "Ghostty submodule mismatch: PIN.json requires ${ghostty_pinned_commit}, found ${ghostty_actual_commit}"
  )
endif()

execute_process(
  COMMAND "${GHOSTTY_GIT_EXECUTABLE}" status --porcelain=v1 --untracked-files=all
  WORKING_DIRECTORY "${GHOSTTY_SOURCE_DIR}"
  RESULT_VARIABLE ghostty_status_result
  OUTPUT_VARIABLE ghostty_changes
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT ghostty_status_result EQUAL 0 OR NOT ghostty_changes STREQUAL "")
  message(FATAL_ERROR
    "the pinned Ghostty source must be clean (tracked and untracked local changes are forbidden)"
  )
endif()
