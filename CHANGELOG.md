# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [4.2.0] - 2026-10-07

- Maintenance release, no functional change.

## [4.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

## [4.0.5] - 2026-10-03

### Changed

- Keep polling when the first read fails, and tell a network outage from a dead session

## [4.0.4] - 2026-09-23

### Changed

- Unit widget: display only, the Devices box drives the unit

### Removed

- Remove the controls widget: the Devices box already drives the unit

## [4.0.3] - 2026-09-23

### Changed

- Control widget: the buttons of one setting per instance, nothing else

## [4.0.2] - 2026-09-23

### Added

- Add a daikin_controls widget to drive a unit, one page of buttons at a time

## [4.0.1] - 2026-09-23

### Changed

- Drive the unit from its dashboard widget, one page of buttons at a time

## [4.0.0] - 2026-09-23

### Added

- Add Gladys 5.1 dashboard widgets, scene triggers and scene actions

## [1.0.12] - 2026-08-15

### Changed

- Declare store catalog categories and upgrade the SDK to 0.12.0 (Gladys 4.86)
- Keep only the climate catalog category

## [1.0.11] - 2026-08-14

### Fixed

- Make a scene able to actually switch a unit off

## [1.0.10] - 2026-08-10

### Added

- Publish the 30-minute consumption and cost of the energy monitoring

### Changed

- Explain the resolution of the Daikin consumption counters
- Detail the energy monitoring setup, and why two counters stay at root

## [1.0.9] - 2026-08-08

### Fixed

- Pin the cover image to the release tag so it can actually change

## [1.0.8] - 2026-08-08

### Changed

- Simple flat cover image for the integration
- Put the Daikin name on the cover image

## [1.0.7] - 2026-08-05

### Changed

- Add CLAUDE.md with the commands and the invariants

### Fixed

- Arm the periodic refresh when the account is linked

## [1.0.6] - 2026-08-05

### Added

- Publish the electrical consumption, and show the API quota left

### Changed

- Explain what the public Onecta API does not expose

### Fixed

- Report unused characteristics from every management point

## [1.0.5] - 2026-08-05

### Added

- Drop the fan mode, and report what the unit declares but we ignore

## [1.0.4] - 2026-08-05

### Fixed

- Stop gating the catalog on a version probe that can fail silently

## [1.0.3] - 2026-08-05

### Added

- Per-axis airflow, comfort modes, and fan controls that stop vanishing

### Changed

- Redraw the cover as a product shot

### Fixed

- Keep the manifest Prettier-clean through a release

## [1.0.2] - 2026-08-05

### Added

- Move the fan controls to the FAN category

### Fixed

- Publish the current values as soon as a device is created

## [1.0.1] - 2026-08-04

First public release.

### Added

- Daikin Cloud integration for Gladys Assistant

### Fixed

- Publish min/max on the On/Off feature, and warn to save before connecting

[Unreleased]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.2.0...HEAD
[4.2.0]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.0.5...v4.1.0
[4.0.5]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.0.4...v4.0.5
[4.0.4]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.0.3...v4.0.4
[4.0.3]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.0.2...v4.0.3
[4.0.2]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.0.1...v4.0.2
[4.0.1]: https://github.com/prohand/gladys-daikin-cloud/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.12...v4.0.0
[1.0.12]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-daikin-cloud/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-daikin-cloud/releases/tag/v1.0.1
