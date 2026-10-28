# Musical cues

Every file here is CC0 1.0 (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/); the licence was checked on each source page
on 2026-10-24. Credit is not required but given.

Each one was cut from the original with ffmpeg: the segment below, a 20 ms fade in, the fade out
given, loudness normalised to -16 LUFS (true peak -1.5 dBTP), resampled to 44.1 kHz stereo and
encoded as 64 kbit/s MP3:

    ffmpeg -ss START -t DUR -i SOURCE -af "afade=t=in:d=0.02,afade=t=out:st=DUR-FADE:d=FADE,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100" -ac 2 -c:a libmp3lame -b:a 64k OUT.mp3

| File | Title | Author | Source | Segment (start, length, fade out) |
|---|---|---|---|---|
| waveStart.mp3 | Dramatic Boss Encounter (Heavy Concept A Bass Master.mp3) | cynicmusic | https://opengameart.org/content/dramatic-boss-encounter | 0 s, 3 s, 1.2 s |
| waveClear.mp3 | Forgotten Victory | yd | https://opengameart.org/content/forgotten-victory | 3.4 s, 4.4 s, 1.6 s |
| boss.mp3 | Sinister Boss Appears! | cynicmusic | https://opengameart.org/content/sinister-boss-appears | 0 s, 6.5 s, 2 s |
| lastStand.mp3 | Dark Intro | Nikke | https://opengameart.org/content/dark-intro | 0.3 s, 6.2 s, 2 s |
| evac.mp3 | Siberian Intro | Vehicle | https://opengameart.org/content/siberian-intro | 0.5 s, 6.5 s, 2 s |
| victory.mp3 | Victory Theme for RPG (Victory1.mp3) | cynicmusic | https://opengameart.org/content/victory-theme-for-rpg | 49.5 s (the ending), 7.2 s, 1 s |
| defeat.mp3 | Sad game over | Emma_MA | https://opengameart.org/content/sad-game-over | 12.95 s (the last phrase), 6.05 s, 0.6 s |
| tierUp.mp3 | Victory Theme for RPG (Victory1.mp3) | cynicmusic | https://opengameart.org/content/victory-theme-for-rpg | 0 s (the opening), 3 s, 1.2 s |
