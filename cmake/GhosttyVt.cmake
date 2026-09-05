include_guard(GLOBAL)

# Build the pinned libghostty-vt without writing generated files into the Git submodule. The output
# and both Zig caches are scoped to the active CMake binary tree and Ghostty commit.
function(lemma_add_pinned_ghostty)
  set(pin_file "${CMAKE_SOURCE_DIR}/third_party/ghostty-metadata/PIN.json")
  set(
    LEMMA_GHOSTTY_SOURCE_DIR "${CMAKE_SOURCE_DIR}/third_party/ghostty"
    CACHE PATH "Pinned Ghostty source tree"
  )
  set(
    LEMMA_GHOSTTY_NIX_SOURCE_REV ""
    CACHE STRING "Locked revision for an immutable Ghostty Nix source"
  )
  set(
    LEMMA_GHOSTTY_ZIG_SYSTEM_DIR ""
    CACHE PATH "Offline Zig dependency directory"
  )
  set(
    LEMMA_GHOSTTY_ZIG_LIBC ""
    CACHE FILEPATH "Zig libc installation description for sandboxed native builds"
  )
  set(
    LEMMA_GHOSTTY_ZIG_TARGET ""
    CACHE STRING "Explicit Zig target for sandboxed packaged builds"
  )
  set(source_dir "${LEMMA_GHOSTTY_SOURCE_DIR}")

  if(NOT EXISTS "${pin_file}")
    message(FATAL_ERROR "missing Ghostty pin metadata: ${pin_file}")
  endif()

  file(READ "${pin_file}" pin_json)
  string(JSON pinned_commit GET "${pin_json}" commit)
  string(JSON pinned_zig GET "${pin_json}" zig_version)
  string(JSON expected_version GET "${pin_json}" expected_version)
  string(JSON emit_xcframework GET "${pin_json}" build_options emit_xcframework)
  string(JSON expected_simd GET "${pin_json}" expected_build_features simd)
  string(JSON production_vt_feature_profile
    GET "${pin_json}" production_vt_feature_profile
  )
  string(JSON production_kitty_graphics
    GET "${pin_json}" expected_build_features kitty_graphics
  )
  string(JSON expected_tmux_control GET "${pin_json}" expected_build_features tmux_control_mode)
  set(LEMMA_GHOSTTY_PINNED_COMMIT "${pinned_commit}" PARENT_SCOPE)

  string(JSON vt_feature_profile_count LENGTH "${pin_json}" vt_feature_profiles)
  math(EXPR vt_feature_profile_last "${vt_feature_profile_count} - 1")
  set(vt_feature_profiles)
  foreach(index RANGE 0 ${vt_feature_profile_last})
    string(JSON profile_name MEMBER "${pin_json}" vt_feature_profiles ${index})
    list(APPEND vt_feature_profiles "${profile_name}")
  endforeach()
  set(
    LEMMA_GHOSTTY_VT_FEATURE_PROFILE "${production_vt_feature_profile}"
    CACHE STRING "Pinned libghostty-vt feature profile"
  )
  set_property(
    CACHE LEMMA_GHOSTTY_VT_FEATURE_PROFILE PROPERTY STRINGS ${vt_feature_profiles}
  )
  if(NOT LEMMA_GHOSTTY_VT_FEATURE_PROFILE IN_LIST vt_feature_profiles)
    list(JOIN vt_feature_profiles ", " supported_profiles)
    message(FATAL_ERROR
      "unknown libghostty-vt feature profile '${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}'; "
      "expected one of: ${supported_profiles}"
    )
  endif()
  set(
    LEMMA_GHOSTTY_PINNED_PROFILE "${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}"
    PARENT_SCOPE
  )
  string(JSON vt_features
    GET "${pin_json}" vt_feature_profiles "${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}" zig_value
  )
  set(vt_feature_names
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
  foreach(feature IN LISTS vt_feature_names)
    string(JSON expected_feature_${feature}
      GET "${pin_json}" vt_feature_profiles "${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}"
      features "${feature}"
    )
  endforeach()
  if(LEMMA_GHOSTTY_VT_FEATURE_PROFILE STREQUAL production_vt_feature_profile AND
     NOT expected_feature_kitty_graphics STREQUAL production_kitty_graphics)
    message(FATAL_ERROR
      "production Ghostty profile and expected kitty-graphics capability disagree"
    )
  endif()

  set(GHOSTTY_PIN_FILE "${pin_file}")
  set(GHOSTTY_SOURCE_DIR "${source_dir}")
  set(GHOSTTY_NIX_SOURCE_REV "${LEMMA_GHOSTTY_NIX_SOURCE_REV}")
  set(
    pin_validation_args
    "-DGHOSTTY_PIN_FILE=${pin_file}"
    "-DGHOSTTY_SOURCE_DIR=${source_dir}"
  )
  if(LEMMA_GHOSTTY_NIX_SOURCE_REV)
    list(
      APPEND pin_validation_args
      "-DGHOSTTY_NIX_SOURCE_REV=${LEMMA_GHOSTTY_NIX_SOURCE_REV}"
    )
  else()
    find_package(Git REQUIRED)
    set(GHOSTTY_GIT_EXECUTABLE "${GIT_EXECUTABLE}")
    list(APPEND pin_validation_args "-DGHOSTTY_GIT_EXECUTABLE=${GIT_EXECUTABLE}")
  endif()
  set(pin_validator "${CMAKE_SOURCE_DIR}/cmake/ValidateGhosttyPin.cmake")
  include("${pin_validator}")

  find_program(ZIG_EXECUTABLE zig REQUIRED)
  set(zig_system_args)
  if(LEMMA_GHOSTTY_ZIG_SYSTEM_DIR)
    list(APPEND zig_system_args --system "${LEMMA_GHOSTTY_ZIG_SYSTEM_DIR}")
  endif()
  set(zig_libc_args)
  if(LEMMA_GHOSTTY_ZIG_LIBC)
    list(APPEND zig_libc_args --libc "${LEMMA_GHOSTTY_ZIG_LIBC}")
  endif()
  set(zig_target_args)
  if(LEMMA_GHOSTTY_ZIG_TARGET)
    list(APPEND zig_target_args "-Dtarget=${LEMMA_GHOSTTY_ZIG_TARGET}")
  endif()
  execute_process(
    COMMAND "${ZIG_EXECUTABLE}" version
    RESULT_VARIABLE zig_result
    OUTPUT_VARIABLE actual_zig
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  if(NOT zig_result EQUAL 0 OR NOT actual_zig STREQUAL pinned_zig)
    message(FATAL_ERROR "Ghostty requires Zig ${pinned_zig}; found ${actual_zig}")
  endif()

  if(NOT CMAKE_BUILD_TYPE)
    message(FATAL_ERROR "a single-config CMAKE_BUILD_TYPE is required for the pinned Ghostty build")
  endif()
  string(JSON optimize ERROR_VARIABLE optimize_error
    GET "${pin_json}" optimization_by_cmake_build_type "${CMAKE_BUILD_TYPE}"
  )
  if(optimize_error)
    message(FATAL_ERROR
      "PIN.json has no Ghostty optimization mapping for CMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}"
    )
  endif()

  if(emit_xcframework)
    set(xcframework_flag true)
  else()
    set(xcframework_flag false)
  endif()
  if(expected_simd)
    set(simd_flag true)
    set(simd_definition 1)
  else()
    set(simd_flag false)
    set(simd_definition 0)
  endif()
  if(expected_feature_kitty_graphics)
    set(kitty_graphics_definition 1)
  else()
    set(kitty_graphics_definition 0)
  endif()
  if(expected_tmux_control)
    set(tmux_control_definition 1)
  else()
    set(tmux_control_definition 0)
  endif()
  if(optimize STREQUAL "Debug")
    set(optimize_definition 0)
  elseif(optimize STREQUAL "ReleaseSafe")
    set(optimize_definition 1)
  elseif(optimize STREQUAL "ReleaseSmall")
    set(optimize_definition 2)
  elseif(optimize STREQUAL "ReleaseFast")
    set(optimize_definition 3)
  else()
    message(FATAL_ERROR "unsupported Ghostty optimization mode in PIN.json: ${optimize}")
  endif()

  set(root "${CMAKE_BINARY_DIR}/_deps/ghostty/${pinned_commit}")
  set(prefix "${root}/${CMAKE_BUILD_TYPE}/${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}")
  set(
    local_cache
    "${root}/zig-cache/local-${CMAKE_BUILD_TYPE}-${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}"
  )
  set(global_cache "${root}/zig-cache/global")
  if(WIN32)
    set(static_library "${prefix}/lib/ghostty-vt-static.lib")
  else()
    set(static_library "${prefix}/lib/libghostty-vt.a")
  endif()
  set(include_dir "${prefix}/include")
  set(feature_manifest "${prefix}/share/lemma/ghostty-vt-features.json")
  file(MAKE_DIRECTORY "${include_dir}")

  add_custom_target(
    lemma_ghostty_vt_validate
    COMMAND "${CMAKE_COMMAND}" ${pin_validation_args} -P "${pin_validator}"
    COMMENT "Validating pinned Ghostty source"
    VERBATIM
  )
  set(feature_validator "${CMAKE_SOURCE_DIR}/cmake/ValidateGhosttyFeatures.cmake")
  add_custom_command(
    OUTPUT "${static_library}" "${feature_manifest}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${local_cache}" "${global_cache}"
    COMMAND "${CMAKE_COMMAND}" ${pin_validation_args} -P "${pin_validator}"
    COMMAND
      "${ZIG_EXECUTABLE}" build
      ${zig_system_args}
      ${zig_libc_args}
      --prefix "${prefix}"
      --cache-dir "${local_cache}"
      --global-cache-dir "${global_cache}"
      -Demit-lib-vt=true
      -Demit-xcframework=${xcframework_flag}
      -Dsimd=${simd_flag}
      "-Dvt-features=${vt_features}"
      ${zig_target_args}
      -Doptimize=${optimize}
    COMMAND
      "${CMAKE_COMMAND}"
      "-DGHOSTTY_FEATURE_PIN_FILE=${pin_file}"
      "-DGHOSTTY_FEATURE_PROFILE=${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}"
      "-DGHOSTTY_FEATURE_LIBRARY=${static_library}"
      "-DGHOSTTY_FEATURE_NM=${CMAKE_NM}"
      "-DGHOSTTY_FEATURE_MANIFEST=${feature_manifest}"
      -P "${feature_validator}"
    WORKING_DIRECTORY "${source_dir}"
    DEPENDS
      "${pin_file}"
      "${pin_validator}"
      "${feature_validator}"
      "${source_dir}/build.zig"
      "${source_dir}/build.zig.zon"
    COMMENT "Building pinned libghostty-vt ${pinned_commit} (${optimize})"
    VERBATIM
    USES_TERMINAL
  )
  add_custom_target(
    lemma_ghostty_vt_build DEPENDS "${static_library}" "${feature_manifest}"
  )
  if(LEMMA_VALIDATE_GHOSTTY_EVERY_BUILD)
    add_dependencies(lemma_ghostty_vt_build lemma_ghostty_vt_validate)
  endif()
  # Preserve the target name used by analysis scripts and existing embedders.
  add_custom_target(zig_build_lib_vt)
  add_dependencies(zig_build_lib_vt lemma_ghostty_vt_build)

  add_library(ghostty-vt-static STATIC IMPORTED GLOBAL)
  set_target_properties(
    ghostty-vt-static
    PROPERTIES
      IMPORTED_LOCATION "${static_library}"
      IMPORTED_LOCATION_RELEASE "${static_library}"
      INTERFACE_INCLUDE_DIRECTORIES "${include_dir}"
      INTERFACE_COMPILE_DEFINITIONS
        "GHOSTTY_STATIC;LEMMA_GHOSTTY_EXPECT_VERSION=\"${expected_version}\";LEMMA_GHOSTTY_EXPECT_SIMD=${simd_definition};LEMMA_GHOSTTY_EXPECT_KITTY_GRAPHICS=${kitty_graphics_definition};LEMMA_GHOSTTY_EXPECT_TMUX_CONTROL_MODE=${tmux_control_definition};LEMMA_GHOSTTY_EXPECT_OPTIMIZE=${optimize_definition};LEMMA_GHOSTTY_VT_FEATURE_PROFILE=\"${LEMMA_GHOSTTY_VT_FEATURE_PROFILE}\""
  )
  if(WIN32)
    set_property(
      TARGET ghostty-vt-static PROPERTY INTERFACE_LINK_LIBRARIES "ntdll;kernel32"
    )
  endif()
  add_dependencies(ghostty-vt-static lemma_ghostty_vt_build)

  message(STATUS "Pinned Ghostty: ${pinned_commit}")
  message(STATUS
    "Ghostty VT feature profile: ${LEMMA_GHOSTTY_VT_FEATURE_PROFILE} (${vt_features})"
  )
  message(STATUS "Ghostty output: ${prefix}")
endfunction()
