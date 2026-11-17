# Integrations

Integrations connect services to screensvr **on the server**. A face declares
the kinds of data it can display; you choose a source separately for each display.
The face controls where the reading appears and how it looks.

## Home Assistant

The read-only connector uses the filtered `subscribe_entities` WebSocket API
available in Home Assistant **2024.1 and newer**. It supports:

- Numeric `sensor` states.
- Temperature sensors with the temperature device class and °C, °F, or K units.
- Humidity sensors with the humidity device class and % units.
- `binary_sensor` on/off states as booleans.
- Short text `sensor` states, up to 200 characters.

There are no service calls, writes, templates, attribute paths, or history.
Units come from Home Assistant; screensvr does not convert them.

### Connect

1. In Home Assistant, open your profile's **Security** section and create a
   long-lived access token. Prefer a dedicated, least-privilege account.
2. In screensvr, open **Integrations → Add integration**.
3. Give the connection a name and enter the Home Assistant base URL, for example
   `http://homeassistant.local:8123`, and token.
4. Choose **Test connection**, then **Save integration**.

The URL must be reachable from the screensvr server/container, not just your
browser. `localhost` inside Docker means that container. Use a LAN hostname/IP or
container-network address where appropriate.

Prefer HTTPS. HTTP exposes the token to anyone able to observe that connection.
Certificates are verified; redirects and embedded URL credentials are rejected.
Private/loopback network addresses are supported, but link-local, metadata-service,
unspecified, and multicast destinations are not.

### Choose a sensor

1. Open a display's settings and choose **Stillroom**, **Slow Hours**, or an installed face
   supporting data inputs.
2. Under **Data sources → Room temperature**, select your named integration.
3. Choose a compatible sensor; search by its friendly name or entity ID.
4. Check the preview and choose **Save changes**.

Trying a source only changes the editor preview. Saving updates the real display.
Another display can use the same face with a different sensor.

Slow Hours hides the temperature when unbound, unavailable, or stale. Other
faces may show a placeholder or a stale indicator instead.
Stillroom shows a quiet placeholder when missing and explicitly labels retained
stale readings; it never invents a temperature before you connect a sensor.

**Privacy:** display URLs and their state/stream APIs require no login. Anyone
able to reach the server can read the selected values, including inputs the
face currently hides. Use a trusted LAN, VPN, or reverse-proxy access control.

### Manage and recover

- Edit a connection to replace its token. A blank token field keeps the saved one;
  saved tokens are never sent back to the management browser.
- Disabling stops its data but does not stop faces or remove their bindings.
- Before deleting, unbind or reassign its sources on all listed displays.
- Changing a display's face clears the previous face's bindings. The new face
  receives nothing until you explicitly choose its sources.
- Invalid credentials stop automatic retries. Replace the token or test the
  saved connection to retry.
- Network interruptions reconnect automatically. Retained readings become stale;
  a fresh selected-entity snapshot is required before they become ready again.
- Home Assistant `unknown`/`unavailable` or a removed source produces unavailable
  data, not a zero or the literal word “unknown”.
- A steady sensor remains fresh while its stream is healthy. A value does not
  become stale just because the sensor has not changed.
- A disconnected tablet locally expires readings after their freshness lease
  (normally 90 seconds), including after waking from sleep.

The connector only sends read commands, but **the Home Assistant token itself
may authorize more**. Entity selection limits what screensvr subscribes to and
publishes; it does not reduce the token's upstream permissions. Revoke the token
in Home Assistant if it is exposed.

## Credentials and backups

Tokens are encrypted in `screensvr.sqlite` using authenticated encryption.
`integration-key`, stored beside the database with restricted permissions, is
needed to decrypt them. Back up and restore the **entire data directory**.

This protects a database-only disclosure, not a compromised process or someone
with the whole data volume. Backups remain sensitive.

If the key is missing, invalid, or mismatched, the integration reports an error;
ordinary clock faces keep running. Restore the matching key and restart.
screensvr will not silently generate a replacement key while saved integrations
exist. If recovery is impossible, unbind/delete all saved integrations, stop
screensvr, preserve the broken data for investigation, remove only the known
unusable `integration-key` if present, then restart and configure new connections.

## Limits and development

Up to 10 connections, 256 selected sources per connection, and 16 inputs per face
are supported. Discovery is bounded to 10,000 entities/16 MiB. Tests, discovery,
and previews are rate-limited and have timeouts; high-rate readings are coalesced.
Readings live in memory, not a history database.

Face authors should use provider-independent inputs and the
[SDK data contract](faces.md#manifest-v2-data-inputs). See the framework-free
[Room Climate example](../examples/room-climate/).

Browser/API tests use a local fake Home Assistant. Real Home Assistant and
Fully Kiosk/Android device checks are still required before a production rollout.
