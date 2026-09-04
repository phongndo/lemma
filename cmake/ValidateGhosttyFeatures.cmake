if(NOT DEFINED GHOSTTY_FEATURE_PIN_FILE OR
   NOT DEFINED GHOSTTY_FEATURE_PROFILE OR
   NOT DEFINED GHOSTTY_FEATURE_LIBRARY OR
   NOT DEFINED GHOSTTY_FEATURE_NM OR
   NOT DEFINED GHOSTTY_FEATURE_MANIFEST)
  message(FATAL_ERROR "Ghostty feature validation requires pin, profile, library, nm, and output")
endif()
if(NOT EXISTS "${GHOSTTY_FEATURE_PIN_FILE}")
  message(FATAL_ERROR "missing Ghostty pin metadata: ${GHOSTTY_FEATURE_PIN_FILE}")
endif()
if(NOT EXISTS "${GHOSTTY_FEATURE_LIBRARY}")
  message(FATAL_ERROR "missing built Ghostty archive: ${GHOSTTY_FEATURE_LIBRARY}")
endif()
if(NOT EXISTS "${GHOSTTY_FEATURE_NM}")
  message(FATAL_ERROR "missing symbol inspector: ${GHOSTTY_FEATURE_NM}")
endif()

file(READ "${GHOSTTY_FEATURE_PIN_FILE}" pin_json)
string(JSON pinned_commit GET "${pin_json}" commit)
string(JSON zig_value ERROR_VARIABLE profile_error
  GET "${pin_json}" vt_feature_profiles "${GHOSTTY_FEATURE_PROFILE}" zig_value
)
if(profile_error)
  message(FATAL_ERROR "unknown Ghostty VT feature profile: ${GHOSTTY_FEATURE_PROFILE}")
endif()

# Every optional feature has one pin-specific implementation or C ABI symbol. Checking the built
# archive catches a profile string that parses but resolves differently from PIN.json. Glyph has no
# public C API, so its private implementation namespace is intentionally tied to this exact pin.
set(feature_names
  snapshot
  formatter
  selection
  render_state
  input_encode
  color
  grid_introspection
  glyph_protocol
  kitty_graphics
)
set(feature_symbols
  ghostty_snapshot_encode
  ghostty_formatter_format
  ghostty_terminal_select_all
  ghostty_render_state_new
  ghostty_key_encoder_new
  ghostty_color_palette_default
  ghostty_cell_get
  terminal.apc.glyph.execute.registerFallible
  ghostty_kitty_graphics_get
)

execute_process(
  COMMAND "${GHOSTTY_FEATURE_NM}" -a "${GHOSTTY_FEATURE_LIBRARY}"
  RESULT_VARIABLE nm_result
  OUTPUT_VARIABLE symbols
  ERROR_VARIABLE nm_error
)
if(NOT nm_result EQUAL 0)
  message(FATAL_ERROR "failed to inspect Ghostty archive: ${nm_error}")
endif()

set(features_json "")
list(LENGTH feature_names feature_count)
math(EXPR feature_last "${feature_count} - 1")
foreach(index RANGE 0 ${feature_last})
  list(GET feature_names ${index} feature)
  list(GET feature_symbols ${index} symbol)
  string(JSON expected
    GET "${pin_json}" vt_feature_profiles "${GHOSTTY_FEATURE_PROFILE}" features "${feature}"
  )
  string(FIND "${symbols}" "${symbol}" symbol_offset)
  if(feature STREQUAL "glyph_protocol" AND symbol_offset EQUAL -1)
    # ReleaseSafe can inline registerFallible; its glyph payload decoder remains out of line.
    # Both are feature-owned implementations, absent when glyph support is compiled out.
    string(FIND "${symbols}" "terminal.apc.glyph.request.Request.Register.decodeGlyfPayload"
      symbol_offset
    )
  endif()
  if(expected AND symbol_offset EQUAL -1)
    message(FATAL_ERROR
      "Ghostty profile '${GHOSTTY_FEATURE_PROFILE}' requires ${feature}, "
      "but '${symbol}' is absent from the archive"
    )
  endif()
  if(NOT expected AND NOT symbol_offset EQUAL -1)
    message(FATAL_ERROR
      "Ghostty profile '${GHOSTTY_FEATURE_PROFILE}' disables ${feature}, "
      "but '${symbol}' remains in the archive"
    )
  endif()
  if(expected)
    set(json_value true)
  else()
    set(json_value false)
  endif()
  if(features_json)
    string(APPEND features_json ",\n")
  endif()
  string(APPEND features_json "    \"${feature}\": ${json_value}")
endforeach()

file(SHA256 "${GHOSTTY_FEATURE_LIBRARY}" archive_sha256)
file(SIZE "${GHOSTTY_FEATURE_LIBRARY}" archive_bytes)
get_filename_component(manifest_directory "${GHOSTTY_FEATURE_MANIFEST}" DIRECTORY)
file(MAKE_DIRECTORY "${manifest_directory}")
file(WRITE "${GHOSTTY_FEATURE_MANIFEST}"
  "{\n"
  "  \"schema\": 1,\n"
  "  \"ghostty_commit\": \"${pinned_commit}\",\n"
  "  \"profile\": \"${GHOSTTY_FEATURE_PROFILE}\",\n"
  "  \"zig_value\": \"${zig_value}\",\n"
  "  \"validation\": \"archive_symbols\",\n"
  "  \"archive_bytes\": ${archive_bytes},\n"
  "  \"archive_sha256\": \"${archive_sha256}\",\n"
  "  \"features\": {\n${features_json}\n  }\n"
  "}\n"
)
