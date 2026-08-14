if(NOT DEFINED GHOSTTY_PIN_FILE OR NOT DEFINED GHOSTTY_SOURCE_DIR OR
   NOT DEFINED GHOSTTY_GIT_EXECUTABLE)
  message(FATAL_ERROR "Ghostty pin validation requires pin, source, and Git paths")
endif()
if(NOT EXISTS "${GHOSTTY_PIN_FILE}")
  message(FATAL_ERROR "missing Ghostty pin metadata: ${GHOSTTY_PIN_FILE}")
endif()

file(READ "${GHOSTTY_PIN_FILE}" ghostty_pin_json)
string(JSON ghostty_pinned_commit GET "${ghostty_pin_json}" commit)

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
