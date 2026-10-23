# Copyright (c) 2024 Realtek Semiconductor Corp.
# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.10)


# Define a variable for the library name
if(1) #set to 1 to enable or variable to for depnedency

    file(GLOB SOURCES "*.c" "*.cpp")
    file(GLOB HEADERS "*.h" "*.hpp")


    # Determine if we should create a library
    if((NOT HEADERS) AND (NOT SOURCES))
        message(STATUS "No source or header files found in ${CMAKE_CURRENT_SOURCE_DIR}.")
		target_include_directories(${APP_TARGET_NAME} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
    endif()

    if(HEADERS AND (NOT SOURCES))
        target_include_directories(${APP_TARGET_NAME} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
    endif()

    if(SOURCES AND (NOT HEADERS))
        target_sources(${APP_TARGET_NAME} PRIVATE ${SOURCES})
    endif()

    if(SOURCES AND HEADERS)
        target_sources(${APP_TARGET_NAME} PRIVATE ${SOURCES})
        target_include_directories(${APP_TARGET_NAME} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
        target_include_directories(${APP_TARGET_NAME} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/../../key_button)
        target_include_directories(${APP_TARGET_NAME} PUBLIC ${ZEPHYR_BASE}/../modules/display/device/key_button/8773G)
    endif()

    # HoneyGUI designer generated UI code lives under src/ (mirrors app/designer/SConscript).
    # The root-level GLOB above only covers this directory; src/ has no CMakeLists of its
    # own, so add its sources and include paths explicitly here at this level.
    file(GLOB DESIGNER_UI_SOURCES
         "src/*.c"
         "src/callbacks/*.c"
         "src/user/*.c"
         "src/ui/*.c")

    if(DESIGNER_UI_SOURCES)
        target_sources(${APP_TARGET_NAME} PRIVATE ${DESIGNER_UI_SOURCES})
        target_include_directories(${APP_TARGET_NAME} PUBLIC
            ${CMAKE_CURRENT_SOURCE_DIR}/src/callbacks
            ${CMAKE_CURRENT_SOURCE_DIR}/src/ui
            ${CMAKE_CURRENT_SOURCE_DIR}/src/user)
    endif()

    # Process subdirectories regardless
    file(GLOB SUBDIRS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/*)

    foreach(subdir ${SUBDIRS})
        # Skip build/: it is the SDL PC-simulator project (hard-codes gcc/g++, links
        # mingw/SDL2/opengl32) and must not be pulled into the Zephyr firmware build.
        # SConscript likewise collects only src/, never build/.
        if(subdir STREQUAL "build")
            continue()
        endif()
        if(IS_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/${subdir})
            if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/${subdir}/CMakeLists.txt)
                add_subdirectory(${subdir})
            else()
                message(STATUS "Skipping directory ${subdir} as it does not contain a CMakeLists.txt file.")
            endif()
        endif()
    endforeach()
endif()
