# Copyright and licensing

Copyright (C) 2026 basefyio

This repository contains two differently licensed parts. Which licence applies
depends on the directory a file lives in.

## Server and dashboard — AGPL-3.0-or-later

Everything under `apps/` — the platform API, the admin dashboard and the
website — plus everything not listed in the MIT section below, is licensed under
the **GNU Affero General Public License, version 3 or (at your option) any later
version**. The full text is in [LICENSE](./LICENSE).

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

Because this is the AGPL, running a modified version of the server to provide a
network service means you must also offer that modified source to its users
(section 13).

## Client libraries — MIT

The packages you install into **your own** application stay permissively
licensed, so building on basefyio never imposes the AGPL on your code:

| Package | Licence |
| --- | --- |
| `packages/sdk` | MIT |
| `packages/cli` | MIT |
| `packages/geo` | MIT |

Each of these carries its own `license` field, and `packages/cli` ships its own
`LICENSE` file.

## Contributions

Contributions are accepted under the licence of the directory they touch — AGPL-3.0-or-later
for the server and dashboard, MIT for the client packages.
