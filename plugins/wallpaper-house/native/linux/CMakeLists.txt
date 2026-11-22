cmake_minimum_required(VERSION 3.16)
project(wallpaper-host CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GTK REQUIRED IMPORTED_TARGET gtk+-3.0)
pkg_check_modules(WEBKIT REQUIRED IMPORTED_TARGET webkit2gtk-4.1)
pkg_check_modules(JSON REQUIRED IMPORTED_TARGET json-glib-1.0)
pkg_check_modules(LAYER_SHELL IMPORTED_TARGET gtk-layer-shell-0)

add_executable(wallpaper-host main.cpp)
target_compile_options(wallpaper-host PRIVATE -Wall -Wextra)
target_link_libraries(wallpaper-host PRIVATE PkgConfig::GTK PkgConfig::WEBKIT PkgConfig::JSON)
if(LAYER_SHELL_FOUND)
  target_compile_definitions(wallpaper-host PRIVATE HAVE_GTK_LAYER_SHELL=1)
  target_link_libraries(wallpaper-host PRIVATE PkgConfig::LAYER_SHELL)
endif()
