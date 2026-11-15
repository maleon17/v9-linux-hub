#!/usr/bin/env bash
# V9 Linux Hub — установка для текущего пользователя.
#   ./install.sh            проверить зависимости, собрать плагин, добавить ярлык и правило udev
#   ./install.sh --uninstall убрать ярлык, автозапуск и правило udev (настройки в ~/.config/v9-linux-hub остаются)
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APP_ID=v9-linux-hub
DESKTOP="$HOME/.local/share/applications/$APP_ID.desktop"
UDEV=/etc/udev/rules.d/70-v9-linux-hub.rules

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$DESKTOP" "$HOME/.config/autostart/$APP_ID.desktop"
  [[ -f $UDEV ]] && { say "Удаляю правило udev (нужен sudo)"; sudo rm -f "$UDEV"; sudo udevadm control --reload-rules; }
  say "Готово. Настройки и кеш: ~/.config/$APP_ID, ~/.cache/$APP_ID"
  exit 0
fi

# ---------- зависимости ----------
missing=()
need() { command -v "$1" >/dev/null 2>&1 || missing+=("$1 ($2)"); }
need electron  "Electron ≥ 30: пакет electron"
need pipewire  "PipeWire ≥ 1.0"
need pactl     "pipewire-pulse / pulseaudio-utils"
need pw-play   "pipewire (утилиты pw-cat)"
need pw-cli    "pipewire"
need pw-dump   "pipewire"
need mysofa2json "libmysofa (пространственный звук)"
need cc        "gcc или clang (сборка плагина голоса)"

lv2ok=0
for d in /usr/lib/lv2 /usr/lib64/lv2 /usr/local/lib/lv2 /usr/lib/x86_64-linux-gnu/lv2; do
  ls -d "$d"/lsp-plugins*.lv2 >/dev/null 2>&1 && lv2ok=1
done
[[ $lv2ok == 1 ]] || missing+=("LSP Plugins LV2 (пакет lsp-plugins-lv2 / lsp-plugins)")

rnok=0
for d in /usr/lib/ladspa /usr/lib64/ladspa /usr/lib/x86_64-linux-gnu/ladspa /usr/local/lib/ladspa; do
  [[ -f $d/librnnoise_ladspa.so ]] && rnok=1
done
[[ $rnok == 1 ]] || warn "RNNoise не найден (пакет noise-suppression-for-voice): без него не будет AI-шумоподавления микрофона"

ls /usr/lib*/spa-0.2/filter-graph/libspa-filter-graph-plugin-builtin.so /usr/lib/*/spa-0.2/filter-graph/libspa-filter-graph-plugin-builtin.so >/dev/null 2>&1 \
  || ls /usr/lib*/spa-0.2/filter-chain >/dev/null 2>&1 \
  || warn "Не нашёл модули filter-chain PipeWire — нужен PipeWire ≥ 1.0"

if (( ${#missing[@]} )); then
  warn "Не хватает:"; printf '   - %s\n' "${missing[@]}"
  cat <<'EOF'
   Arch / CachyOS:  sudo pacman -S electron pipewire pipewire-pulse libmysofa lsp-plugins-lv2 gcc
                    (+ noise-suppression-for-voice из AUR)
   Fedora:          sudo dnf install electron pipewire-utils libmysofa lsp-plugins-lv2 gcc noise-suppression-for-voice
   Debian / Ubuntu: sudo apt install pipewire-bin pulseaudio-utils libmysofa-utils lsp-plugins-lv2 gcc
                    (Electron: npm i -g electron или пакет из дистрибутива)
EOF
  exit 1
fi

# ---------- сборка плагина голоса ----------
say "Собираю плагин эффектов голоса"
cc -O2 -fPIC -shared -o "$DIR/dsp/v9_voice.so" "$DIR/native/v9_voice.c" -lm

# ---------- доступ к ресиверу (WebHID) ----------
if [[ ! -f $UDEV ]]; then
  say "Добавляю правило udev для ресивера гарнитуры (нужен sudo)"
  sudo tee "$UDEV" >/dev/null <<'EOF'
# MCHOSE V9 Pro USB-ресивер (291d:385d): доступ для пользователя за активным сеансом
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="291d", ATTRS{idProduct}=="385d", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="291d", ATTR{idProduct}=="385d", TAG+="uaccess"
EOF
  sudo udevadm control --reload-rules
  sudo udevadm trigger --subsystem-match=hidraw --subsystem-match=usb
fi

# ---------- ярлык ----------
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=V9 Linux Hub
GenericName=Headset settings
Comment=Unofficial settings app for the MCHOSE V9 Pro headset
Exec="$DIR/v9hub"
Icon=$DIR/assets/icon.png
Terminal=false
Categories=AudioVideo;Audio;Settings;HardwareSettings;
StartupWMClass=V9 Linux Hub
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1 || true

say "Готово. Запуск: из меню («V9 Linux Hub») или $DIR/v9hub"
say "При первом запуске интерфейс производителя (~45 МБ) скачается с cdn.mchose.com.cn."
