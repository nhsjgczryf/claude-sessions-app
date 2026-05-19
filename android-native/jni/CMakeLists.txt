# NDK build for the PTY JNI library. Loaded by Pty.kt's static
# initializer (System.loadLibrary("claudesessions_pty")). The .so is
# packaged into the APK under lib/<abi>/ for the abiFilters we enable
# in app/build.gradle (currently arm64-v8a only).
cmake_minimum_required(VERSION 3.22.1)
project(claudesessions_pty C)

add_library(claudesessions_pty SHARED pty.c)

# Link against Android's logging library so LOGI / LOGE in pty.c
# can be viewed with adb logcat -s ClaudePty.
find_library(log-lib log)
target_link_libraries(claudesessions_pty ${log-lib})

target_compile_options(claudesessions_pty PRIVATE
    -Wall
    -Wno-unused-parameter
    -Werror=implicit-function-declaration
    -fvisibility=hidden
)
