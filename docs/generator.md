# Client generator

The server's `/` page creates standalone clients in the browser and displays the embedded release version in its header. Connection, appearance and each panel's defaults have separate configuration pages. Search spans those pages; Keyboard shortcuts opens the same searchable action editor used by the client. The password can be revealed temporarily. Generation validates every page and opens the page containing an invalid field.

Starting panel includes both Browser (server Chromium) and the experimental Proxy browser. Choosing Proxy browser opens a blank client-rendered panel with Local HTML and does not start Chromium.

`client/settings-schema.js` is the shared registry for generator fields, client settings, accepted values and safe defaults. Add reusable settings to this registry rather than maintaining a second generator form. Existing configuration keys retain their meanings; nested `browser`, `binary`, `image`, `video`, `audio`, `cad`, `taskManager`, and `docker` objects contain panel defaults. `keybinds` stores action overrides. Missing fields use the registry defaults. CAD section bounds use normalized 0–1 coordinates. Live sessions remain workspace state.

Terminal fonts remain generation-time assets: select a bundled Nerd Font or upload a WOFF2, WOFF, TTF or OTF file up to 4 MiB. Only the selected font is embedded. A startup command runs once for each new terminal and is stored in the client alongside the password. Keep generated clients private. Generating a client never connects a terminal or sends the password or uploaded font to the server.

HTML, SVG, compressed HTML, compressed SVG and compressed data URL outputs preserve the same additive `eya-config-v1` configuration. JSON is script-escaped. Open SVG directly as a document because image embedding disables interactive scripts. Compressed outputs require `DecompressionStream`. A data URL with a large embedded font can exceed Chromium’s navigation limit. Chromium also blocks data-origin WebSockets to local addresses. If Connect cannot reach the server from a data URL, **Open server client** opens the hosted HTML client in a new tab. Generate an HTML file to keep custom embedded settings for a local server. All output continues to use the permanent updater's existing artifact/config contract.

Sources: `client/generator.js`, `client/generator.template.html`, `client/settings-schema.js` and `client/keybinds.js`. Rebuild with `node client/build.mjs` before compiling the server. `tests/generator-settings.cjs` bundles the generator sources into an isolated loopback fixture and checks pages, search, password visibility, defaults, shortcuts, configuration escaping, output packaging, validation and mobile bounds.

Files defaults include a searchable extension-to-panel opener table. Terminal defaults include the link destination: Browser panel by default, or External tab. These choices share the client settings registry and survive all generated artifact formats.

Appearance includes the optional floating mobile panel switcher. Binary viewer defaults include layout, encoding, colors and numeric display controls; both use the shared registry and preserve safe defaults when absent.
