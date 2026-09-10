# Fantasy HQ ESPN Connect (browser extension)

One click to connect an ESPN account to the dashboard, instead of digging cookies out of DevTools.

## Install (Chrome / Edge / Brave)

1. Download this folder (on GitHub: **Code → Download ZIP**, unzip, find the `extension` folder).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder.

## Use

1. Sign in at fantasy.espn.com.
2. Click the extension icon, enter your dashboard address (e.g. `https://myleagues.duckdns.org`), click **Connect**.
3. The dashboard opens with Settings pre-filled; click **Save & refresh**.

## How it works / privacy

The extension reads two cookies from espn.com (`SWID`, `espn_s2`) and opens your dashboard with them in the URL fragment (the part after `#`), which browsers never send to any server. The dashboard page reads the fragment and saves the values through its normal signed-in Settings. Nothing is sent to anyone but the dashboard address you type.
