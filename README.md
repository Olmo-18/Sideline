# Touchline

Touchline is a phone-friendly organiser for a weekly football game. Players use a shared link to join, drop out or claim a reserve offer. The organiser can add guests, pick and edit teams, copy line-ups to WhatsApp and track attendance.

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

- Choose the Tuesday date for each fixture. Kick-off is fixed at 7 pm UK time. Sign-ups close at kick-off.
- Each member signs up with their full name. Their browser remembers their sign-up. If they switch phones or clear their cookies, the organiser can update the entry for them. Add guests individually, for example `Alec +1` as a separate spot.
- When a spot opens, the first reserve gets an in-app offer and the spot is held for up to 24 hours or until kick-off. If they decline or the offer expires, the next reserve gets the offer. Players need to reopen the link to check. The organiser can message the player in WhatsApp and confirm on their behalf.
- Shuffle makes two randomly selected teams from confirmed players. Swap exchanges two players across the teams. Copy formats the current teams for pasting into WhatsApp.
- **Add fixture** schedules a separate game. As organiser, use the arrows or pick a date to edit its own sign-ups and teams. Players see only the next game on the shared link. A scheduled fixture with the same kick-off as the next recurring game becomes the main fixture when the series advances, carrying over its roster and teams. For a weekly game, enable **Repeat every Tuesday at 7 pm**. The next fixture opens automatically two hours after kick-off. Open **Attendance sheet** in the organiser’s Fixtures panel or bookmark `/attendance` to see who played on each date. Confirmed players appear on the sheet as soon as they sign up and count as having played at kick-off. Use **Mark absent** or **Mark played** to correct the list.

## Optional Twilio texts

In the service environment, set `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY` (the key SID), `TWILIO_API_SECRET` and `TWILIO_FROM_NUMBER` (the SMS-capable Twilio number including its country code). Use a two-way sender that supports replies and STOP opt-outs. Redeploy after setting the variables. The optional phone field and consent box only appear when all four settings are present. Verify delivery to your own number before sharing the app. Custom texts require a Twilio account that supports them.

Players opt in per fixture. Touchline texts them when their place is confirmed, they join the waiting list or a place is offered. The last text asks them to accept the offer in the app. Numbers do not appear on rosters or attendance sheets. Players can turn off texts from the same browser or reply STOP. Touchline limits the number of queued texts to 6 per mobile and 80 across the service in 24 hours. The app still records sign-ups if a text fails.
