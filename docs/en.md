# Daikin Cloud

Control your Daikin air conditioners from Gladys, through the **official Daikin
Onecta cloud API** — the same cloud the Onecta mobile app talks to. No hardware
to add, no reverse engineering: your units keep working exactly as they do
today, Gladys just becomes another remote control.

## What you get

For every air conditioner of your Daikin account, Gladys creates one device
with the features your model actually supports:

| Feature             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| On/Off              | Turn the unit on and off                                            |
| Mode                | Auto, Cooling, Heating, Drying, Fan only                            |
| Target temperature  | The setpoint of the mode currently active                           |
| Fan mode            | How the unit picks its airflow: Auto, Quiet, or a manual speed      |
| Fan speed           | The manual speed level, on the scale your unit declares (often 1-5) |
| Horizontal airflow  | The left/right airflow direction                                    |
| Vertical airflow    | The up/down airflow direction                                       |
| Powerful mode       | Daikin's "Powerful" mode (switch)                                   |
| Econo mode          | Daikin's "Econo" mode (switch)                                      |
| Streamer mode       | The "Streamer" air purification mode (switch)                       |
| Keep dry            | The indoor unit's "Keep dry" advanced function                      |
| Room temperature    | The temperature the unit measures (sensor, kept in history)         |
| Outdoor temperature | The temperature the outdoor unit measures (sensor, kept in history) |

A model without louvers gets no airflow direction, a model without a fan gets
no fan speed, a model without the Streamer function gets no Streamer switch:
only what the hardware reports is published. The choices offered in the
interface are also restricted to what the unit accepts — a unit without a
"Drying" mode never shows one.

Two details about the fan, because Gladys and Daikin do not use quite the same
words:

- **Fan mode** carries Daikin's three airflow modes. _Auto_ is Daikin's auto,
  _Low_ is its quiet mode, and _Medium_ means "run at the manual speed" — the
  level itself is the separate Fan speed control. Gladys always shows the five
  values of its list: picking _High_ also switches to manual, and _Off_ is
  refused, because a Daikin fan has no off of its own (turn the unit off
  instead).
- **Fan speed** only shows a value while the unit is actually running on a
  manual level. In auto or quiet there is no level to show, so the control stays
  empty until you set one — and setting one switches the unit to manual.

The features describe what your unit can do across **all** its operation
modes, not what it can do at this instant. Daikin declares no manual fan level
in Drying, for example: without that, a device discovered while the unit was
dehumidifying would have lost its speed control for good. In exchange, a
command sent in a mode that cannot take it is refused with a clear message
rather than failing silently.

Daikin reports some functions read-only depending on the model and firmware —
"Keep dry" almost always is. Those are published as sensors, without a switch
the API would refuse anyway.

> **The fan controls need Gladys 4.79 or newer**, and the per-axis airflow
> direction (plus the restricted mode lists) need 4.84.3. In between, the
> louvers fold into a single "Oscillation" feature. On an older Gladys the
> integration still works and simply publishes less.

Heat pumps (Altherma…) are partially supported: their on/off, mode and outdoor
temperature work, but their water temperature setpoint is not exposed — this
integration targets air conditioners.

## Before you start: create your Daikin application

The Onecta API is free, but each user needs their own application. It takes two
minutes:

1. Go to the [Daikin developer portal](https://developer.cloud.daikineurope.com/)
   and create an account (you can use the same email as your Onecta account).
2. Open **My apps** → **New app**.
3. Give the app a name (for example `Gladys`).
4. In **Redirect URIs**, paste the address Gladys shows you. Open the
   **Configuration** tab of the Daikin Cloud integration in Gladys: the address
   is displayed right under the **Connect** button, with a copy button next to
   it. By default it is:

   ```
   https://my.gladysassistant.com/redirect/oauth
   ```

   This page is hosted by Gladys and simply bounces the browser back to your
   own instance — Daikin, like most providers, refuses a plain `http://`
   address, which is how most people reach their Gladys at home. If you already
   serve Gladys over HTTPS, you can untick the option in the Configuration
   screen and declare your own address instead; whatever address is shown is
   the one to paste here, character for character.

5. Save the app, then copy its **Client ID** and its **Client secret**.

## Configuration

1. In Gladys, open **Integrations → Daikin Cloud → Configuration**.
2. Paste the **Client ID** and the **Client secret** of your Daikin app.
3. **Save** — the credentials must be stored before the connection can start.
4. Click **Connect** next to _Daikin account_. A new tab opens on the Daikin
   sign-in page: log in with the account your air conditioners are paired with
   in the Onecta app, and accept the authorization.
5. You come back to Gladys, the integration reads your account, and your units
   appear in the **Discovery** tab. Add the ones you want.

Gladys stores the resulting tokens itself and renews them automatically. You
should not have to go through this flow again.

## Refresh interval and API quota

Daikin limits a developer account to **200 API calls per day and 20 per
minute**. This is the one constraint to keep in mind, and it drives how the
integration behaves:

- one refresh reads **all** your units in a single call, so the number of units
  does not change the cost;
- every command you send (on/off, a temperature, a fan speed…) costs one more
  call — and changing a fan speed to a fixed level costs two;
- the default interval of **900 seconds (15 minutes)** spends 96 calls a day and
  leaves the rest for your commands.

You can raise the interval up to 6 hours, or lower it down to 10 minutes if you
rarely control your units from Gladys. Going lower than that would spend the
whole daily budget before the day ends, which is why the field stops there.

Because of this quota, the integration does **not** use the per-device polling
of Gladys (which is one minute at the slowest): it runs its own schedule.

## Actions

**Test the connection** reads your Daikin account right away and reports how
many units it found and how many API calls are left for today. Use it after
connecting your account, or whenever you want to force a refresh.

## Device status badge

Each device carries a badge showing how Gladys reaches it:

- **Cloud** — normal operation.
- **Cloud with an orange dot** — the unit is reachable but reports a fault;
  check it in the Onecta app.
- **Unreachable** — Daikin cannot reach the unit (its Wi-Fi adapter is offline,
  a power cut, a router change…). Commands are refused with a clear message and
  no state is published, so your charts do not get a flat line that looks like a
  real measurement.

## Troubleshooting

**"Fill in the client ID and the client secret first, then save."**
The credentials are empty or were not saved. Fill both fields, click Save, then
Connect.

**The Daikin page says the redirect URI is invalid.**
The address declared in your Daikin app does not match the one Gladys uses.
Copy it again from under the Connect button — including the protocol and
without a trailing slash.

**"The Daikin session expired, please reconnect your account."**
The refresh token was revoked (password changed, app deleted on the portal,
account access removed). Click Connect again.

**"Daikin API quota reached, increase the refresh interval."**
You hit the 200 calls a day, most likely by combining a short interval with a
lot of commands, or by running several integrations on the same Daikin app. The
quota resets on its own; raise the refresh interval to avoid hitting it again.

**A change made in the Onecta app takes a while to show up in Gladys.**
Expected: Daikin's API has no push notifications, so Gladys only sees a change
at the next refresh. Lower the interval, or use the _Test the connection_ action
to force a read.

**Nothing appears in the Discovery tab.**
Make sure the units are visible in the Onecta app with the same account, then
run _Test the connection_: the message tells you how many units the API
returned.

The integration logs every call it makes: check the integration logs in the
Gladys interface for the full detail.
