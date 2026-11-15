#!/bin/bash
# Отладочный запуск в виртуальном X-дисплее (окно не видно), DevTools на :9555. stop — остановить.
cd "$(dirname "$0")"
LOG=${MHUB_LOG:-${XDG_RUNTIME_DIR:-/tmp}/v9hub-dev.log}
if [ "$1" = stop ]; then pkill -f '[e]lectron[0-9]*/electron --remote-debugging-port=9555'; pkill -f '^Xvfb :[0-9]+ -screen 0 1600x900x24'; exit 0; fi
MHUB_DEBUG=1 MHUB_NO_DSP=1 MHUB_PROFILE=${MHUB_PROFILE:-${XDG_RUNTIME_DIR:-/tmp}/v9hub-devprofile} env -u WAYLAND_DISPLAY ELECTRON_OZONE_PLATFORM_HINT=x11 xvfb-run -a -s "-screen 0 1600x900x24" \
  electron . --remote-debugging-port=9555 --remote-allow-origins='*' --ozone-platform=x11 > "$LOG" 2>&1
