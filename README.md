# Universo 3D — Dashboard de apps para Linux (Kali / XFCE)

Lanzador de aplicaciones en un universo 3D interactivo, construido con **Tauri 2**
y **Three.js**. Muestra **todas** las apps `.desktop` del sistema, incluidas las
ocultas (`NoDisplay=true`), como planetas brillantes que puedes ordenar en
distintas disposiciones.

## Características

- **4 disposiciones**: galaxia espiral, esfera, anillos por categoría y rejilla.
- **Atajo global** (`Super+Space` por defecto): invoca o esconde el universo desde
  cualquier parte del escritorio.
- **Búsqueda difusa** (atajo `/`): `gimp` encuentra "GNU Image Manipulation
  Program". La cámara vuela al mejor resultado; `Enter` lo lanza.
- **Orden por uso**: los favoritos ocupan las órbitas interiores, seguidos de las
  apps que más usas (frecuencia + recencia combinadas).
- **Acciones del `.desktop`** (tecla `A`): modos de lanzamiento extra declarados
  por la app, como "Nueva ventana privada" de Firefox.
- **Favoritos** (clic derecho o tecla `F`): halo dorado y órbita junto al sol.
- **Apps ocultas** marcadas con un anillo turquesa (toggle "Ocultas" para filtrar).
- **Filtro por categoría** y modo "solo favoritos".
- **Lanzador de comandos** (atajo `` ` ``): con historial navegable (`↑`/`↓`) y
  confirmación explícita antes de ejecutar.
- **Monitor del sistema**: CPU por núcleo, RAM, swap, red y carga en vivo.
- **5 temas** (Cosmic, Emerald, Sunset, Mono, Matrix) y ajustes de bloom, brillo
  estelar, nebulosas y velocidad, todo persistente.
- **Navegación con teclado**: flechas para saltar entre planetas, `Enter` para lanzar.
- **Animación warp** al lanzar y efecto de agujero negro (doble clic en el sol).
- **Modo daemon**: queda residente en la bandeja del sistema; `Esc` oculta la
  ventana y el siguiente clic la muestra al instante.

## Requisitos

Toolchain de Rust (stable) y Node.js 18+, más las bibliotecas de desarrollo de
WebKitGTK y GTK:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
                 libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
                 build-essential curl wget file pkg-config
```

Si no tienes Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Desarrollo

```bash
npm install     # instala three.js, @tauri-apps/api y el CLI de Tauri
npm run dev     # compila y abre la app con recarga en caliente
```

`npm run dev` y `npm run build` ejecutan automáticamente
`scripts/vendor-three.sh`, que copia Three.js y `@tauri-apps/api` desde
`node_modules/` a `src/renderer/vendor/` (ignorado por git). El webview los
importa con un importmap relativo, sin bundler.

Si compilas con `cargo` directamente, ejecuta antes ese script a mano:

```bash
npm install && bash scripts/vendor-three.sh
```

## Compilar e instalar

```bash
npm run build
```

Genera los paquetes en `src-tauri/target/release/bundle/`:

```bash
# .deb (recomendado en Kali/Debian/Ubuntu): instala el binario y el .desktop
sudo dpkg -i src-tauri/target/release/bundle/deb/*.deb

# o bien el AppImage, portable
chmod +x src-tauri/target/release/bundle/appimage/*.AppImage
```

El `.deb` registra la app en el menú de aplicaciones (`Exec=universe-3d`), así
que no hace falta copiar ningún `.desktop` a mano.

### Añadir a la barra de XFCE

Clic derecho en la barra → **Panel** → **Añadir nuevos elementos…** →
**Lanzador**, y busca **Universe 3D**.

## Atajos

| Tecla | Acción |
|---|---|
| `Super+Space` | Mostrar / ocultar el universo (global, configurable) |
| `/` | Buscar |
| `` ` `` | Lanzador de comandos |
| `A` | Acciones del `.desktop` de la app enfocada |
| `F` / clic derecho | Marcar como favorito |
| `↑ ↓ ← →` | Navegar entre planetas |
| `Enter` | Lanzar la app enfocada |
| `Esc` | Cerrar panel / ocultar la ventana |
| Doble clic en el sol | Absorber / expulsar los planetas |

## Configuración

Las preferencias se guardan en `~/.config/universe-3d/prefs.json`
(favoritos, recientes, contadores de uso, historial de comandos, tema y ajustes
visuales). Para cambiar el atajo global, añade una clave `hotkey`:

```json
{ "hotkey": "Super+D" }
```

El índice de iconos se cachea en `~/.cache/universe-3d/icon-index.json` y se
regenera solo cuando cambian los directorios de iconos del sistema.

## Estructura

- `src-tauri/src/main.rs` — comandos Tauri: lanzamiento, monitor, prefs, ventana,
  bandeja y atajo global.
- `src-tauri/src/desktop.rs` — escaneo de `.desktop`, acciones y resolución de
  iconos con caché.
- `src/renderer/` — UI y escena 3D (Three.js).
- `src/renderer/tauri-bridge.js` — puente `invoke` entre la UI y Rust.
- `scripts/vendor-three.sh` — vendoriza las dependencias JS al renderer.

## Notas de seguridad

- El webview corre con una **CSP restrictiva** y `withGlobalTauri` desactivado,
  de modo que `invoke` no queda expuesto como global del navegador.
- Las apps se lanzan **sin pasar por la shell**: el `Exec=` del `.desktop` se
  parsea a `argv` según la especificación XDG, así que los metacaracteres de
  shell en un `.desktop` malicioso quedan inertes (cubierto por tests).
- El lanzador de comandos sí usa la shell (es su propósito), pero exige una
  confirmación explícita mostrando el comando exacto antes de ejecutarlo.

## Licencia

MIT — ver [LICENSE](LICENSE).
