# Allow Incoming UDP 4747 Connections (macOS)

DTF uses UDP port 4747. macOS Application Firewall is **application-based**, not port-based — allow the listening executable, not the port.

## 1. Find which process is listening on UDP 4747

```bash
sudo lsof -nP -iUDP:4747
```

Example output:

```text
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
Python   1234 user    5u  IPv4  ...         UDP *:4747
```

Note the **PID**.

## 2. Determine the command associated with the PID

```bash
ps -p <PID> -o command=
```

Example:

```bash
ps -p 1234 -o command=
```

Output:

```text
/Users/me/project/.venv/bin/python server.py
```

## 3. Find the executable path

If the process command already contains the full path, use it directly:

```text
/Users/me/project/.venv/bin/python
```

Otherwise:

```bash
which python3
```

For a virtual environment:

```bash
ls -l .venv/bin/python
realpath .venv/bin/python
```

## 4. Add the executable to the firewall allow-list

Add the executable:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw \
  --add /path/to/executable
```

Allow incoming connections:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw \
  --unblockapp /path/to/executable
```

Example:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw \
  --add /Users/me/project/.venv/bin/python

sudo /usr/libexec/ApplicationFirewall/socketfilterfw \
  --unblockapp /Users/me/project/.venv/bin/python
```

## 5. Verify firewall configuration

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --listapps
```

Confirm the executable appears in the list.

## 6. Verify the process is listening on all interfaces

```bash
sudo lsof -nP -iUDP:4747
```

Look for:

```text
*:4747
```

That means the service is listening on all network interfaces.

If you see `127.0.0.1:4747` or `localhost:4747`, the service is only reachable from this machine regardless of firewall settings.

## 7. Find the Mac's LAN IP address

```bash
ipconfig getifaddr $(route get default | awk '/interface:/{print $2}')
```

Example output:

```text
192.168.1.42
```

## 8. Test connectivity

On the Mac, monitor incoming UDP 4747 packets:

```bash
sudo tcpdump -ni any udp port 4747
```

From another machine:

```bash
echo "test" | nc -u 192.168.1.42 4747
```

Replace `192.168.1.42` with the LAN IP from step 7.

If packets appear in `tcpdump`, the network path and firewall are working. UDP has no connection handshake, so `nc -u` may appear to hang even when communication is working — `tcpdump` is the most reliable check.
