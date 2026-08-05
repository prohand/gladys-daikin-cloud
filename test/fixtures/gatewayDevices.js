// -----------------------------------------------------------------------------
// Daikin `GET /v1/gateway-devices` payloads, trimmed to what the integration
// reads but keeping the real shape (management points, characteristics, the
// per-operation-mode setpoint and fan control trees).
// -----------------------------------------------------------------------------

/** A split air conditioner: 5 modes, room setpoint, fan speed and both louvers. */
export const SPLIT_UNIT = {
  id: '13995b32-fc6e-43ed-918e-5d2b01095ccb',
  deviceModel: 'dx23',
  isCloudConnectionUp: { settable: false, value: true },
  managementPoints: [
    {
      embeddedId: 'gateway',
      managementPointType: 'gateway',
      macAddress: { settable: false, value: 'a0:b1:c2:d3:e4:f5' },
    },
    {
      embeddedId: 'climateControl',
      managementPointType: 'climateControl',
      name: { settable: false, value: 'Living room' },
      onOffMode: { settable: true, values: ['on', 'off'], value: 'on' },
      isInErrorState: { settable: false, value: false },
      // The comfort toggles of a split unit, as the Onecta app shows them.
      powerfulMode: { settable: true, values: ['on', 'off'], value: 'off' },
      econoMode: { settable: true, values: ['on', 'off'], value: 'off' },
      streamerMode: { settable: true, values: ['on', 'off'], value: 'on' },
      isPowerfulModeActive: { settable: false, value: false },
      operationMode: {
        settable: true,
        values: ['auto', 'dry', 'cooling', 'heating', 'fanOnly'],
        value: 'cooling',
      },
      temperatureControl: {
        settable: true,
        value: {
          operationModes: {
            auto: {
              setpoints: {
                roomTemperature: {
                  settable: true,
                  value: 25,
                  minValue: 18,
                  maxValue: 30,
                  stepValue: 0.5,
                },
              },
            },
            cooling: {
              setpoints: {
                roomTemperature: {
                  settable: true,
                  value: 22,
                  minValue: 18,
                  maxValue: 32,
                  stepValue: 0.5,
                },
              },
            },
            heating: {
              setpoints: {
                roomTemperature: {
                  settable: true,
                  value: 21,
                  minValue: 10,
                  maxValue: 30,
                  stepValue: 0.5,
                },
              },
            },
          },
        },
      },
      sensoryData: {
        settable: false,
        value: {
          roomTemperature: { settable: false, value: 24.5 },
          outdoorTemperature: { settable: false, value: 31 },
        },
      },
      // Electrical consumption, exactly as Daikin shapes it: `d` is 24
      // two-hour slots (12 for yesterday, then 12 for today) and `m` is 24
      // months (12 for last year, then 12 for this one).
      consumptionData: {
        settable: false,
        value: {
          electrical: {
            unit: 'kWh',
            heating: {
              // yesterday: 0.5 each — must NOT be counted; today: 0.1 each
              d: [...Array(12).fill(0.5), ...Array(12).fill(0.1)],
              w: [...Array(7).fill(1), ...Array(7).fill(0.5)],
              // last year: 9 each; this year: 1 in January, 2 in February...
              m: [...Array(12).fill(9), ...Array.from({ length: 12 }, (_, i) => i + 1)],
            },
            cooling: {
              d: [...Array(12).fill(0.3), ...Array(12).fill(0.05)],
              w: [...Array(7).fill(2), ...Array(7).fill(0.25)],
              m: [...Array(12).fill(8), ...Array(12).fill(0.5)],
            },
          },
        },
      },
      fanControl: {
        settable: true,
        value: {
          operationModes: {
            cooling: {
              fanDirection: {
                horizontal: {
                  currentMode: { settable: true, value: 'stop', values: ['stop', 'swing'] },
                },
                vertical: {
                  currentMode: {
                    settable: true,
                    value: 'swing',
                    values: ['stop', 'swing', 'windNice'],
                  },
                },
              },
              fanSpeed: {
                currentMode: { settable: true, value: 'fixed', values: ['quiet', 'auto', 'fixed'] },
                modes: {
                  fixed: { value: 3, settable: true, minValue: 1, maxValue: 5, stepValue: 1 },
                },
              },
            },
            heating: {
              fanSpeed: {
                currentMode: { settable: true, value: 'auto', values: ['quiet', 'auto', 'fixed'] },
                modes: {
                  fixed: { value: 1, settable: true, minValue: 1, maxValue: 5, stepValue: 1 },
                },
              },
            },
            dry: {
              fanSpeed: { currentMode: { settable: true, value: 'auto', values: ['auto'] } },
            },
          },
        },
      },
    },
    {
      embeddedId: 'indoorUnit',
      managementPointType: 'indoorUnit',
      softwareVersion: { settable: false, value: '1.2.3' },
      // "Keep dry" belongs to the indoor unit, and Daikin reports it
      // read-only on most models.
      dryKeepSetting: { settable: false, values: ['on', 'off'], value: 'on' },
    },
  ],
};

/** A unit whose Wi-Fi adapter is offline, and which reports a fault. */
export const OFFLINE_UNIT = {
  id: '2a6f4de3-1f1a-4e0e-9a83-9c2c1f0f4b11',
  deviceModel: 'dx4',
  isCloudConnectionUp: { settable: false, value: false },
  managementPoints: [
    {
      embeddedId: 'climateControl',
      managementPointType: 'climateControl',
      name: { settable: false, value: 'Bedroom' },
      onOffMode: { settable: true, values: ['on', 'off'], value: 'off' },
      isInErrorState: { settable: false, value: true },
      operationMode: { settable: true, values: ['cooling', 'heating'], value: 'heating' },
      temperatureControl: {
        settable: true,
        value: {
          operationModes: {
            heating: {
              setpoints: {
                roomTemperature: {
                  settable: true,
                  value: 19,
                  minValue: 10,
                  maxValue: 30,
                  stepValue: 1,
                },
              },
            },
          },
        },
      },
    },
  ],
};

/**
 * A heat pump: it drives a water temperature, not a room setpoint, and has no
 * fan at all — the integration must still expose its on/off and its mode.
 */
export const HEAT_PUMP_UNIT = {
  id: '7c1c9d4e-53a1-4a55-9a2f-0b3d9f7a6c22',
  deviceModel: 'altherma',
  isCloudConnectionUp: { settable: false, value: true },
  managementPoints: [
    {
      embeddedId: 'climateControlMainZone',
      managementPointType: 'climateControl',
      name: { settable: false, value: 'Heat pump' },
      onOffMode: { settable: true, values: ['on', 'off'], value: 'on' },
      operationMode: { settable: true, values: ['heating', 'cooling', 'auto'], value: 'heating' },
      temperatureControl: {
        settable: true,
        value: {
          operationModes: {
            heating: {
              setpoints: {
                leavingWaterOffset: {
                  settable: true,
                  value: 0,
                  minValue: -10,
                  maxValue: 10,
                  stepValue: 1,
                },
              },
            },
          },
        },
      },
      sensoryData: {
        settable: false,
        value: { outdoorTemperature: { settable: false, value: 8 } },
      },
    },
    {
      embeddedId: 'domesticHotWaterTank',
      managementPointType: 'domesticHotWaterTank',
      onOffMode: { settable: true, values: ['on', 'off'], value: 'on' },
    },
  ],
};

export const ALL_DEVICES = [SPLIT_UNIT, OFFLINE_UNIT, HEAT_PUMP_UNIT];
