# Universo 3D — Dashboard de apps para Kali Linux (XFCE)

Lanzador de aplicaciones en un universo 3D interactivo. Muestra **todas** las apps
`.desktop` del sistema, incluidas las ocultas (`NoDisplay=true`), como planetas
brillantes que puedes ordenar en distintas disposiciones.

## Características

- **4 disposiciones**: galaxia espiral, esfera, anillos por categoría y rejilla.
- **Apps ocultas** marcadas con un anillo turquesa (toggle "Ocultas" para filtrar).
- **Favoritos** (clic derecho o tecla `F`): halo dorado y órbita junto al sol, persistentes.
- **Recientes**: las apps lanzadas se colocan en las órbitas interiores.
- **Búsqueda instantánea** (atajo `/`): la cámara vuela al mejor resultado; `Enter` lo lanza.
- **Navegación con teclado**: flechas para saltar entre planetas, `Enter` para lanzar.
- **Animación warp** al lanzar: la cámara se sumerge en el planeta con destello bloom.
- **Modo daemon**: queda residente en la bandeja del sistema; `Esc` oculta la ventana
  y el siguiente clic en el panel la muestra al instante.
- **Bloom real** (postprocesado), nebulosas y starfield multicapa.
- Arrastra para orbitar, rueda del ratón para zoom. Rotación automática en reposo.

## Instalación

```bash
npm install
```

## Ejecutar

```bash
npm start
```

## Añadir a la barra superior de XFCE

1. Clic derecho en la barra → **Panel** → **Añadir nuevos elementos…** → **Lanzador**.
2. Clic derecho en el nuevo lanzador → **Propiedades** → botón **+** (Añadir).
3. Busca **Universo 3D** (tras copiar el lanzador, ver abajo) o añade un elemento
   nuevo apuntando a `launcher/universe3d.sh` con el icono `launcher/icon.svg`.

Para que aparezca en el menú de aplicaciones:

```bash
cp "launcher/universe3d.desktop" ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
```

## Estructura

- `src/main.js` — proceso principal Electron: escaneo de `.desktop`, iconos, lanzamiento.
- `src/preload.js` — puente IPC seguro.
- `src/renderer/` — UI y escena 3D (Three.js).
- `launcher/` — script, `.desktop` e icono para el panel de XFCE.
