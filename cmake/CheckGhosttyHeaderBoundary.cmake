if(NOT DEFINED LEMMA_SOURCE_DIR)
  message(FATAL_ERROR "LEMMA_SOURCE_DIR is required")
endif()

file(
  GLOB_RECURSE lemma_sources
  LIST_DIRECTORIES false
  "${LEMMA_SOURCE_DIR}/apps/*.cpp"
  "${LEMMA_SOURCE_DIR}/include/*.hpp"
  "${LEMMA_SOURCE_DIR}/src/*.cpp"
  "${LEMMA_SOURCE_DIR}/src/*.hpp"
  "${LEMMA_SOURCE_DIR}/tests/*.cpp"
  "${LEMMA_SOURCE_DIR}/tests/*.hpp"
)

set(violations)
foreach(source IN LISTS lemma_sources)
  file(READ "${source}" contents)
  if(contents MATCHES "#[ \t]*include[ \t]*[<\"]ghostty/")
    file(RELATIVE_PATH relative "${LEMMA_SOURCE_DIR}" "${source}")
    if(NOT relative MATCHES "^src/terminal/")
      list(APPEND violations "${relative}")
    endif()
  endif()
endforeach()

if(violations)
  list(JOIN violations ", " encoded)
  message(FATAL_ERROR "Ghostty headers escaped the terminal boundary: ${encoded}")
endif()
