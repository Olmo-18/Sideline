# Touchline

Touchline is a phone-friendly organiser for a weekly football game. Players use a shared link to join, drop out or claim a reserve offer. The organiser can add guests, pick and edit teams, copy line-ups to WhatsApp and record payments.

## Deploy from GitHub

1. Extract the archive and push its contents, including the hidden `.github` folder, to a new GitHub repository.
2. In Render, choose **New → Blueprint** and connect that repository. Render reads `render.yaml` and provisions the Docker service and its persistent disk. The configured Starter service and disk are paid Render resources.
3. Set `ORGANISER_PASSWORD` in the Blueprint setup to a strong password of at least 12 characters. Keep it out of the repository.
4. Open the service URL, choose **Organiser**, sign in and set up the first fixture. Share the service URL in WhatsApp. GitHub Actions tests each push and Render deploys when checks pass.

GitHub hosts the code and runs the checks. Render hosts the running app. The SQLite database lives on the mounted disk and survives redeploys. Run one service instance per group. Keep the disk when replacing or recreating the service.

## Run locally

Install Node.js 24, then run:

```sh
ORGANISER_PASSWORD='choose-a-long-local-password' npm start
```

Open http://localhost:3000. Local records go into the ignored `data/` directory. Run `npm test` to exercise the sign-up and organiser workflows.

## How the weekly game works

- Kick-off is entered and shown in UK time. Sign-ups close at kick-off.
- Each member signs up with a display name. Their browser remembers their sign-up. If they switch phones or clear their cookies, the organiser can update the entry for them. Add guests individually, for example `Alec +1` as a separate spot.
- When a spot opens, the first reserve gets an in-app offer and the spot is held for up to 24 hours or until kick-off. If they decline or the offer expires, the next reserve gets the offer. Players need to reopen the link to check. The organiser can message the player in WhatsApp and confirm on their behalf.
- Shuffle makes two randomly selected teams from confirmed players. Swap exchanges two players across the teams. Copy formats the current teams for pasting into WhatsApp.
- The fixed per-player fee defaults to £6 and stays the same as players join or drop out. Share a payment link or payment instructions, then record the amounts received in the payment sheet. Anyone with the game link can see the fixture, confirmed names, teams and payment instructions. Only the organiser can see everyone’s payment statuses.
- **Add fixture** schedules a separate game. As organiser, select any scheduled fixture to edit its own sign-ups and teams. Players see the main fixture on the shared link. A scheduled fixture with the same kick-off as the next recurring game becomes the main fixture when the series advances, carrying over its roster and teams. For a weekly game, enable **Repeat every Tuesday at 7 pm**. The next fixture opens automatically two hours after kick-off. Use **Payment sheet** to record transfers and download a CSV of balances. Confirmed players are counted at kick-off. Correct no-shows under **Past attendance** after the fixture rolls over. Earlier payments marked paid count towards each player’s total. Balances are matched by name across fixtures, ignoring capitalisation and extra spaces.

Player sign-up asks for a first and last name. The public player list and public teams show first name and surname initial for new sign-ups. The organiser's payment sheet uses full names. The fixture editor defaults to a fixed £6 fee.
