# Using screensvr

Manage screensvr from its home page, usually `http://YOUR_SERVER_IP:3000`.
Sign in with your administrator password. Each tablet opens its own display
link instead of the management page.

New here? Follow the [quick start](../README.md#quick-start) first.

## Displays and previews

A **display** is a saved screen with a name, a permanent URL, and a timezone.
A **face** is its visual design. A **scene** saves a face together with its
settings and selected data sources.

### Add a display

1. Choose **Add display**.
2. Enter a name and select a face.
3. Choose **Create display**, then copy the **Display URL**.
4. Open that URL on your tablet or monitor.

The timezone initially follows the browser used to create the display. Change
it in display settings if needed. Clocks, schedules, weather dates, and timed
appointments use the configured display timezone, not the server's timezone.

Use **Display link** to retrieve the same URL later. Renaming a display or
restarting screensvr does not change it. Display links do not contain passwords
or require a login; they are readable by anyone who can reach the server.

### Change a display's look

Open the display's settings, select a face, and adjust its options. The preview
shows your changes before you choose **Save changes**.

- Saving changes to the active scene updates connected screens automatically.
- Changing a scene's face resets that scene's settings and data sources.
  Other scenes are unaffected.
- With scheduling enabled, edit the look under **Scenes & schedule**. Display
  settings still let you change the name and timezone.
- Connection status means the browser is communicating with screensvr. It does
  not confirm that the tablet's physical screen is on or that Fully Kiosk is healthy.

Deleting a display removes its URL and disconnects its screens.

## Scenes and scheduling

Scenes let one display have different looks throughout the day. They belong to
that display, not to a shared library. Each display starts with a **Default**
scene and scheduling disabled.

### Save a scene

1. Open the display's **Scenes & schedule**.
2. Choose **New scene**, or select a saved scene and choose **Duplicate scene**.
3. Give it a name, choose a **Face**, and adjust its settings.
4. Select any **Data sources**, check the preview, and choose **Save scene**.

Saving an inactive scene does not put it on screen. Choose **Activate scene**
to use it manually. Switching scenes restores each scene's own saved sources;
it does not copy or clear another scene's selections.

You can save up to 32 scenes per display. A display must keep at least one scene.

### Add a night clock

Choose **Add night clock** in **Scenes & schedule**. This creates a Slow Hours
scene with a black background, dim numerals, and no glow, seconds, or decorative
content. Save any adjustments and activate it manually, or add it to a schedule.

This dims the rendered page only. Set hardware brightness, screen power, and
motion detection in Fully Kiosk or on the tablet.

### Create a weekly schedule

1. Save the scenes you want to use.
2. Open **Weekly schedule** and choose **Add schedule entry**.
3. Select the weekdays, start time, and scene for each entry.
4. Turn on **Enable scheduling** and choose **Save schedule**.

For example:

| Days      | Start | Scene          |
| --------- | ----- | -------------- |
| Mon–Fri   | 07:00 | Daytime photos |
| Sat–Sun   | 09:00 | Daytime photos |
| Every day | 19:00 | Evening clock  |
| Every day | 23:00 | Night clock    |

Times follow the display's timezone. The most recent entry stays active until
the next one, including overnight and on days without entries. You do not need
an end time or an entry at midnight.

Enabling a schedule immediately selects the scene for the current time.
Disable scheduling before manually activating a scene; disabling keeps the
scene currently on screen. Temporary overrides, sunrise/sunset rules, and
event-triggered schedules are not supported.

Up to 64 entries are allowed, and each entry can include multiple weekdays.
Two entries cannot have the same start time on the same weekday.

### Daylight saving and disconnections

During a spring-forward gap, skipped entries apply when the clock jumps forward;
the latest skipped start wins. During a repeated autumn hour, an entry applies
at its first occurrence only.

Scheduling runs on the server. A sleeping or disconnected display keeps its
loaded face and resynchronizes to the current scene when it reconnects. Offline
schedule transitions and offline startup are not supported.

## Choose data sources

Add a connection under **Integrations**, then select its readings, photos, or
calendars under a display or scene's **Data sources**. Only faces that declare
those inputs show the corresponding controls.

- **Slow Hours / Stillroom:** select a Home Assistant room-temperature sensor.
- **Weather Hours:** select current weather and, optionally, daily/hourly forecasts.
- **Photo Hours:** select an Immich album, mounted folder, individual mounted photo,
  or curated Wikimedia/NASA album from **Online backgrounds**, which is already
  enabled without integration setup.
- **Calendar Hours:** select up to eight calendars for the next appointment.

See the [integration guide](integrations.md) for setup and provider requirements.
Trying a source changes only the preview. An inactive scene's saved sources do
not create background subscriptions.

**Publish deliberately:** anyone who can reach a display link can read its
selected data, even if the face hides it. Selecting photos publishes the whole
selected collection, not just the current image. Calendar titles require an
explicit per-calendar opt-in; busy-only is the default.

## Manage the face library

Open **Face library** to see the included faces and your installed packages.
Choose **Install face** to upload a ZIP, confirm that you trust its source,
then select it in a display or scene.

Faces contain executable JavaScript. Only install trusted packages; the browser
sandbox reduces access but does not make malicious code safe.

Only one version of each face ID can be installed. To replace an installed face:

1. Change or delete every scene using it, including inactive scenes.
2. Remove the old package from **Face library**.
3. Install its replacement and select it in the desired scenes.

Bundled faces cannot be removed. There is no automatic face-update service.
See [Building a face](faces.md) if you want to create a package.

## Everyday troubleshooting

| Problem                                      | What to check                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tablet cannot open its display           | Use the server's LAN address, not `localhost`. Check that the server is running and port 3000 is reachable from the tablet.                           |
| Fully Kiosk does not start the screensaver   | Check Fully PLUS, the screensaver URL and timer, and its device settings. screensvr does not detect tablet idle time.                                 |
| The clock is wrong                           | Check the display timezone and the tablet's date/time. Faces use the browser's clock.                                                                 |
| A scene will not activate manually           | Disable scheduling first.                                                                                                                             |
| A schedule looks wrong                       | Check its weekdays and the display timezone. A scene remains active until the next entry, even across days.                                           |
| Sensor, weather, or calendar data is missing | Check the integration status, selected sources for this scene, and whether the source is supported. Clocks can keep working without data.             |
| Photos are missing                           | Check album access or the read-only mount and file permissions. The server/container must be able to reach the source.                                |
| A custom face fails                          | Try **Retry face** or switch to a bundled face. Check the package's SDK use and browser compatibility.                                                |
| Changes do not reach a screen                | Check its connection and server reachability. A reverse proxy must allow the display's event stream; see [deployment](deployment.md#reverse-proxies). |

An already loaded face can keep rendering during a server or network outage,
but reloading or starting a browser requires the server. Selected readings
expire locally and become stale. A loaded photo may remain visible, but
screensvr is not an offline photo library.

For administrator password recovery, storage, and backups, see
[Deployment and operation](deployment.md). For vulnerabilities, follow the
[security policy](../SECURITY.md), not a public issue with sensitive details.
