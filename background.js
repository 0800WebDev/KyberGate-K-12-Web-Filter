// KyberGate Chrome Extension v2.36 — Background Service Worker
// Full-featured K-12 web filter with proxy-backed policy sync

// ============================================================
// Proxy API Client — all data flows through proxy endpoints
// (replaces direct proxy REST API access)
// ============================================================

const PROXY_BASE = "https://proxy.kybergate.com";

// ============================================================
// Per-device API auth: Authorization: Bearer hex(HMAC_SHA256(udid, secret))
// Shared secret matches the Go proxy (proxy/state.go) + Express API.
// Verified statelessly server-side. Devices with only the proxy config profile
// never run this code, so they are unaffected.
// ============================================================
const DEVICE_AUTH_SECRET = "kybergate-device-token-v1-2026";
let _deviceTokenCache = { udid: null, token: null };

async function computeDeviceToken(udid) {
  if (!udid) return null;
  if (_deviceTokenCache.udid === udid && _deviceTokenCache.token) return _deviceTokenCache.token;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(DEVICE_AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(udid));
    const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    _deviceTokenCache = { udid, token };
    return token;
  } catch (e) { console.error("device token compute failed", e); return null; }
}

// Build auth headers for the current enrolled device (best-effort).
async function deviceAuthHeaders() {
  try {
    const udid = (typeof config !== "undefined" && config.deviceId)
      ? config.deviceId
      : (await chrome.storage.sync.get(["deviceId"])).deviceId;
    const token = await computeDeviceToken(udid);
    return token ? { "Authorization": `Bearer ${token}` } : {};
  } catch (_) { return {}; }
}

class ProxyApiClient {
  // POST to proxy endpoint with JSON body
  async post(endpoint, data) {
    try {
      const authHeaders = await deviceAuthHeaders();
      const res = await fetch(`${PROXY_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(data),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { console.error(`Proxy API error (${endpoint}):`, e); return null; }
  }

  // GET from proxy endpoint
  async get(endpoint) {
    try {
      const authHeaders = await deviceAuthHeaders();
      const res = await fetch(`${PROXY_BASE}${endpoint}`, { headers: { ...authHeaders } });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { console.error(`Proxy API error (${endpoint}):`, e); return null; }
  }

  // Device heartbeat/status update
  async updateDevice(orgId, deviceId, data) {
    return this.post("/api/heartbeat", { orgId, deviceId, ...data });
  }

  // Write activity log(s)
  async writeLogs(orgId, logs) {
    return this.post("/api/logs", { orgId, logs: Array.isArray(logs) ? logs : [logs] });
  }

  // Write AI chat log entry
  async writeAiChatLog(orgId, entry) {
    return this.post("/api/ai-chat-log", { orgId, ...entry });
  }

  // Write pulse alert
  async writePulseAlert(orgId, alert) {
    return this.post("/api/pulse-alert", { orgId, ...alert });
  }

  // Get pulse config (included in policy response)
  async getPulseConfig(orgId) {
    return this.get(`/api/policy/${orgId}?section=pulse`);
  }

  // Write classroom session activity
  async writeSessionActivity(orgId, sessionId, deviceId, data) {
    return this.post("/api/classroom/activity", { orgId, sessionId, deviceId, ...data });
  }

  // Get teacher commands for device
  async getCommands(orgId, deviceId) {
    return this.get(`/api/commands/${orgId}/${deviceId}`);
  }

  // Mark command as processed
  async markCommandProcessed(orgId, deviceId, commandId, result) {
    // 🔴 2026-08-26: this used to ALWAYS post an empty body. proxy/api.go treats an
    // empty ack body as success, so every command the device silently refused to run
    // was recorded as "completed". That is exactly what Jeremy saw: "It syncs but
    // doesn't close." Send the real outcome so a refusal cannot masquerade as success.
    return this.post(`/api/commands/${orgId}/${deviceId}/${commandId}/ack`, result || {});
  }

  // Get chat messages for classroom session
  async getChatMessages(orgId, sessionId) {
    return this.get(`/api/classroom/chat?orgId=${orgId}&sessionId=${sessionId}`);
  }

  // Upload screenshot
  async uploadScreenshot(orgId, deviceId, data) {
    return this.post("/api/screenshot", { orgId, deviceId, ...data });
  }
}

const api = new ProxyApiClient();

// ============================================================
// Domain Lists (hardcoded fallbacks + augmented by policy)
// ============================================================

const GAMING_DOMAINS = new Set([
  "1000games.com","1001games.com","10fastfingers.com","1v1.lol","1v1lol.com",
  "2048.io","2048game.com","2048online.com","2pgames.com","3dcargames.com",
  "66games.io","77games.io","addictinggames.com","agame.com","agar.io",
  "agar.live","agma.io","akinator.com","amogus.io","among-us.io",
  "among-us.online","amongusonline.io","anstream.com","antstream.com","apexlegends.com",
  "app.rainway.com","aquapark.io","arcadegames.com","arcadeprehacks.com","arcadespot.com",
  "arcadestreet.com","archive.org/details/consolelivingroom","armor-games.com","armorgames.com","arras.io",
  "asphalt9.com","ballblast.io","ballrush.games","baseballbros.io","basketballlegends.io",
  "basketballstars.io","basketballstars.me","basketbros.com","basketbros.io","basketrandom.io",
  "bassdrop.io","battle.net","battledudes.io","battlefor.io","battleroyale.io",
  "battleship.io","bestcrazygames.com","bestgames.com","betrayal.io","betternet.co",
  "bgames.com","bigfun.com","bigshot-boxing.com","bitlife-life-simulator.co","bitlife-online.com",
  "bitlife.com","bitlifegame.com","bitlifeonline.com","bitlifesimulator.io","blacknut.com",
  "blitz.gg","blitzstats.com","blizzard.com","bloble.io","blockaway.net",
  "blockcraft3d.com","blooket.cc","blooket.com","blooket.world","blookethacks.com",
  "blooketplay.com","blookettower.com","bloxd.io","bloxflip.com","blumgi.com",
  "bobtherobber.com","bobtherobber.io","bonk.io","boosteroid.com","bored.com",
  "boredbutton.com","bowlingbros.io","boxingbros.io","brainpop.com/games","brawlhalla.io",
  "brawlstars.com","brawlstats.com","brightestgames.com","bruh.io","brutal.io",
  "build-now.gg","buildnow-gg.com","buildnow.gg","buildroyale.io","burgerking.games",
  "burrito-craft.com","callofduty.com","candycrush.com","carcrush3d.com","cargames.com",
  "cdkeys.com","cdromance.org","cellcraft.io","chess.com","citywalks.live",
  "clashofclans.com","clashroyale.com","class-activity.space","class-games.lol","classicgame.com",
  "classicube.net","classroom-6x.com","classroom-activities.lol","classroom-games.lol","classroom-games.pages.dev",
  "classroom.lol","classroom15x.com","classroom30x.com","classroom6x.com","classroom6x.io",
  "classroom6x.net","classroom6x.org","classroomgames.org","classx.org","clickjogos.com.br",
  "cloud.boosteroid.com","colonist.io","connections.swellgarfo.com","cookingfever.io","coolmath.com",
  "coolmathgames.com","coolmathgames.org","coolrom.com","copter.io","craftingandbuilding.com",
  "crazy-cattle-3d.io","crazybattle.io","crazycars.com","crazycattle.io","crazycattle3d.com",
  "crazycattle3d.io","crazygames.com","crosswordsolver.org","crossyroad.com","crossyroad.io",
  "croxy.network","croxy.org","csgostash.com","cubes2048.io","cubic.io",
  "cuttheropegame.com","dak.gg","deadshot.io","deeeep.io","defly.io",
  "destinyitemmanager.com","destinytracker.com","desura.com","devast.io","diep.io",
  "diepz.io","dinogame.app","dinosaurgame.io","doblons.io","dogar.io",
  "dontfiltermybro.com","dordle.io","dos.zone","dota2.com","dotabuff.com",
  "doublefine.com","drawaria.online","drawasaurus.org","drawthis.io","drawz.io",
  "dreamteamfc.com","drift-boss.io","drift-hunters.com","driftboss.com","driftboss.io",
  "driftgame.com","driftgame.io","drifthunters.com","drifthunters.io","drifthunters2.com",
  "drifthuntersgame.com","drifthuntersunblocked.com","drive-mad.com","drivemad.com","drivemad.io",
  "ducklife.io","ducklife4.com","ducklifegame.com","ducklings.io","duckparty.io",
  "ea.com","ea.com/play","eagler.dev","eagler.pages.dev","eaglercraft.biz",
  "eaglercraft.com","eaglercraft.dev","eaglercraft.me","eaglercraft.net","eaglercraft.org",
  "eaglercraft.pages.dev","eaglercraft.win","eaglerx.com","eaglerx.me","eaglerx.net",
  "eduplay.pages.dev","electricman.io","electricman2.com","embeddr.pages.dev","emulator.games",
  "emulatorgames.com","emulatorgames.net","emulatorgames.online","emulatorjs.org","emulatoronline.com",
  "emulatorzone.com","emuparadise.me","english-class.lol","epicgames.com","esea.net",
  "ev.io","evowars.io","evoworld.io","faceit.com","facepunch.io",
  "fakeupdate.net","fallguys-online.com","fallguys.io","famousbirthdays.com","fan.school",
  "fanatical.com","fandom.com","fanschool.com","fightz.io","findtheinvisiblecow.com",
  "flasharcade.com","florr.io","flyordie.io","fnaf-online.com","fnaf.com",
  "fnaf.io","fnaf2.com","fnaf3.com","fnaf4.com","fnafgame.io",
  "fnafgames.io","fnafsisterlocation.com","fnafunblocked.com","fnafworld.com","fnf-game.com",
  "fnf-game.io","fnf-mods.com","fnf-online.com","fnfgame.org","fnfgo.com",
  "fnfplay.com","fnfunblocked.com","fnfunblocked.org","foes.io","fog.com",
  "foggy.com","footballbros.io","fortnite-online.com","fortnite.com","fortnite.io",
  "fortnitetracker.com","fortniteunblocked.com","free-online-games.com","freecell.io","freecoproxy.com",
  "freegames.org","freegames.pages.dev","freeproxy.io","freeproxy.win","freeunblockedgames.org",
  "freewebarcade.com","freewebproxy.com","freezenova.com","fridaynightfunkin.com","fridaynightfunkin.net",
  "fridaynightfunkin.org","friv.com","friv2017.com","friv2018.com","friv2019.com",
  "friv2online.com","friv360.com","friv5.me","friv5online.com","frivclassic.com",
  "frivclub.com","frivland.com","frivoo.com","frivoriginal.com","fruitninja.io",
  "funbrain.com","funmath.pages.dev","g2a.com","gamaplay.com","gamasexual.com",
  "gamaverse.com","game-embed.pages.dev","game-oldies.com","gamedistribution.com","gameflare.com",
  "gameflare.io","gameframe.pages.dev","gamehub.pages.dev","gameis.net","gamejolt.com",
  "gamejolt.net","gamekarma.com","gamenora.com","gamepix.com","gamepost.com",
  "gameproxy.pages.dev","gamequark.io","games.co.uk","games.pages.dev","gamesbutler.com",
  "gamesbx.com","gamesfreak.net","gamesfrog.com","gamesgames.com","gamesgo.net",
  "gamesnacks.com","gamesonline.com","gamesunblocked.pages.dev","gamezhero.com","gamezone.pages.dev",
  "gamingcloud.com","gamivo.com","gamulator.com","gartic.io","gats.io",
  "gauntletgame.io","gba.js.org","gba4ios.com","gbafun.com","gd.games",
  "geekprank.com","geforcenowhub.com","generals.io","genshinimpact.com","geo-fs.com",
  "geofs.com","geofs.org","geography-lessons-9.org","geography-lessons.org","geography-lessons.space",
  "geography-lessons10.space","geography-quiz.lol","geoguessr.co","geoguessr.com","geometrydash.co",
  "geometrydash.io","geometrydash.org","geometrydashfree.com","geometrydashonline.com","getaway-shootout.com",
  "getawaygame.com","getawayshootout.io","gimkit.com","girlsgogames.com","gog.com",
  "googleunblockedgames.com","goproxy.com","greenmangaming.com","gulper.io","hacker.org",
  "hackertyper.com","hackertyper.net","happywheels.com","happywheels.io","happywheelsfull.com",
  "happywheelsgame.org","heardle.app","henrystickmin.com","hexanaut.io","hide.me/proxy",
  "history-class.lol","history-lessons.space","history-quiz.lol","hltv.org","hockeybros.io",
  "hola.org","hole.io","holey.io","homework-games.lol","homework-help.lol",
  "homework-help.space","hooda-math.com","hoodamath.com","hoodamath.org","hooinet.com",
  "horrorgames.io","hoxxvpn.com","hoyolab.com","hoyoverse.com","html5games.com",
  "htmlproxy.com","humblebundle.com","humoroutcasts.com","idlebreakout.com","idlebreakout.org",
  "idleon.com","idleparadise.com","igre.games","incredibox.com","incredibox.io",
  "indiegala.com","interactivegames.pages.dev","io-games.io","iogames.fun","iogames.network",
  "iogames.onl","iogames.space","itch.io","itch.zone","jacksmith.io",
  "jetpackjoyride.io","jigsaw-puzzle.org","jigsawplanet.com","jogoji.com","joylandgames.com",
  "kahoot.com","kahoot.it","kahootbot.com","kahoothack.com","karatebros.io",
  "kart.club","kartbros.io","keybr.com","keygames.com","kinguin.net",
  "kirka.io","kizi.com","kongregate.com","kour.io","krunker.io",
  "lagged.com","lagged.games","leagueofgraphs.com","leagueoflegends.com","learning-hub.lol",
  "learntofly.com","learntofly3.com","learnx.org","leopardjs.com","lichess.org",
  "littlebigsnake.com","littlebigsnake.io","lolbeans.io","lolchess.gg","lordz.io",
  "loveroms.online","luna.amazon.com","madalin.games","madalinstuntcars.com","madalinstuntcars2.com",
  "madalinstuntcars3.com","mahjong-online.com","mahjong.com","mapcrunch.com","massivematch.io",
  "math-games.com","math-games.lol","math-lessons.space","math-play.com","math-playground.lol",
  "math-quiz.lol","math6.lol","math6x.com","mathgames.com","mathgames.pages.dev",
  "mathlab.pages.dev","mathplayground.com","mathplayground.lol","mathpractice.pages.dev","mathx.org",
  "mcpe-monster.com","mcpedl.com","medal.tv","meeland.io","megaproxy.io",
  "mergefruits.io","minecraft-classic.io","minecraft-online.com","minecraft-online.io","minecraft.games",
  "minecraft.net","minecraftforfreex.com","minecraftfree.org","minecraftgames.co.uk","minecraftpe-mods.com",
  "minecraftskins.com","minesweeper.online","minesweeperonline.com","miniblox.io","miniclip.com",
  "minicraft.io","minigiants.io","miniplay.com","miniproxy.io","mobalytics.gg",
  "monkey-mart.com","monkey-mart.io","monkeymart.com","monkeymart.io","monkeymart.org",
  "monkeytype.com","moomoo.io","mope.io","moto-x3m.com","motox3m.com",
  "motox3m.io","mousebreaker.com","musclewiki.com","myabandonware.com","myinstants.com",
  "n64games.com","narrow.one","narwhale.io","needforspeed.com","neocities.org",
  "nerdle.net","nerdlegame.com","nesbox.com","neshq.com","nesplay.com",
  "newgrounds.com","nightpoint.io","nightstrikr.io","ninja.io","nitrotype.com",
  "nookazon.com","notdoppler.com","now.gg","nowgg.app","nowgg.club",
  "nowgg.lol","nowgg.me","nowgg.pro","nuuvem.com","nytimescrossword.com",
  "oceanar.io","octordle.com","oldgameshelf.com","onlinegames.io","op.gg",
  "openfront.io","origin.com","oyunlar1.com","papas-games.com","papasburgeria.co",
  "papascookingames.com","papasfreezeria.co","papasgames.io","papaslouie.com","papelio.io",
  "paper.io","papergames.io","paperio.com","parkingfury.com","parkingfury3d.com",
  "parsec.app","phosphorus.github.io","pirate.io","pirateproxy.live","pixelcombat.io",
  "plainproxies.com","planetminecraft.com","play-games.com","play-old-pc-games.com","play.geforcenow.com",
  "play.pages.dev","play2048.co","play2048.com","playamongus.io","playclassic.games",
  "playcover.io","playemulator.com","playio.me","playit.pages.dev","playkey.net",
  "playminigames.net","playnite.link","playoverwatch.com","playr.org","playretrogames.com",
  "plays.org","plays.tv","playsatisfactory.com","playstation.com/remote-play","plazmaburst.io",
  "plonga.com","pointerpointer.com","poki.com","poki.nl","pokimania.com",
  "polytrack.io","populationoneweb.com","porofessor.gg","powerline.io","powerlinegame.com",
  "poxel.io","pranx.com","primarygames.com","privacywall.org","prodigy.com",
  "proxy-list.org","proxybay.xyz","proxyium.com","proxyium.io","proxyium.net",
  "proxyium.org","proxysite.cloud","proxysite.one","pubg-online.com","pubg.com",
  "pubg.io","puzzle-online.com","quizit.online","quizizz.com","quordle.com",
  "racegames.com","rainway.com","rallychampion.net","rallypointgame.com","rblx.trade",
  "rblxland.com","rblxwild.com","rbxcdn.com","rbxflip.com","rbxgold.com",
  "readingx.org","recess-games.lol","repuls.io","retro-bowl.io","retro-bowl.org",
  "retrobowl.click","retrobowl.io","retrobowl.me","retrobowl.org","retrobowlonline.com",
  "retrobowlunblocked.com","retrobowlunblocked.lol","retrogames.cc","retrostic.com","richup.io",
  "riddle-school.com","roblox.com","robloxplayer.com","rocket-bot-royale.io","rocketgoal.io",
  "rogold.live","rolimons.com","romhacking.net","romsdownload.net","romsforever.co",
  "romsfun.com","romsgames.net","romsget.io","romsmania.cc","run-3.com",
  "run3.com","run3.online","runthree.io","scarygames.com","scarymaze.io",
  "scarymaze.org","scarymazegame.org","school-activities.space","school-break.lol","school-fun.space",
  "school-games.lol","schoolfun.pages.dev","schoolunblockedgames.com","science-class.lol","science-lessons.space",
  "science-quiz.lol","scienceclass.lol","sciencegames.pages.dev","sciencex.org","sedecordle.com",
  "senpa.io","seterra.com","setgame.com","shadow.tech","shellshock.io",
  "shellshockers.io","shockwave.com","shootem.io","shooterz.io","silvergames.com",
  "sitegets.com","sitenable.ch","sitenable.co","sitenable.com","sitenable.info",
  "sites-unblocker.com","sites.google.com","sites.google.com/site/unblockedgame","skibiditoilet.io","skribbl.io",
  "skribblio.co","skribbltypo.io","slain.io","slendergame.com","slither.io",
  "slope-ball.com","slope-game.com","slope-game.io","slope3.io","slope3d.com",
  "slopegame.io","slopegame.org","slopemania.com","slopes-game.com","slopeunblocked.lol",
  "slowroads.io","smartdnsproxy.com","smashkarts.com","smashkarts.io","snail-ide.com",
  "snakeio.online","snaker.io","snesfun.com","snesfun.org","snesmini.com",
  "snesnow.com","snokido.com","snow-rider-3d.io","snowball.io","snowrider.io",
  "snowrider3d.com","snowrider3d.io","soccerbros.io","softgames.com","softgames.de",
  "solitaire.io","solitaired.com","soundboard.com","soundbuttonsworld.com","speedify.com",
  "spele.nl","spellingbee.io","spinz.io","sploop.io","sporcle.com",
  "sprunki.com","sprunki.io","sprunkigame.com","sprunkionline.com","spys.one",
  "ssega.com","stabfish.io","stadia.google.com","starblast.io","statsroyale.com",
  "stealthebrainrot.io","steam.com","steamcommunity.com","steampowered.com","stickfight.io",
  "stickman-games.com","stickmanfighting.com","store.epicgames.com","store.steampowered.com","stremio.com",
  "study-break.space","study-games.lol","studybreak.pages.dev","studyhall.lol","studyx.org",
  "stumbleguys.com","stumbleguys.io","subway-surfers.io","subwaysurfers.co","subwaysurfersgame.io",
  "sudoku.com","suikagame.com","suikagame.io","supercell.com","superhot-game.com",
  "superhot.com","superhot.io","supersnake.io","survev.io","surviv.io",
  "swordbattle.io","swordz.io","symbaloo.com","takepoint.io","taming.io",
  "tanki.io","tankroyale.io","tanksio.online","techgrapple.com","temple-run-2.io",
  "temple-run.io","templerun.io","tennisbros.io","territorial.io","tetr.io",
  "tetris.com","tetris.io","thegamerator.com","theuselessweb.com","thispersondoesnotexist.com",
  "thistoesnotexist.com","thisxdoesnotexist.com","tlauncher.org","toomkygames.com","topgames.com",
  "topspeedgames.com","totaljerkface.com","totallyaccurate.com","tracker.gg","traderie.com",
  "trafficracer.io","trafficrider.io","triep.io","tunnel-rush.io","tunnelrush.io",
  "turbowarp.org","twitch.tv","twoplayergames.org","typeracer.com","typing.com",
  "typingclub.com","tyrone-unblocked-games.com","tyronegames.com","ubg100.com","ubg235.com",
  "ubg365.com","ubg365.io","ubg66.com","ubg69.com","ubg6x.com",
  "ubg7.com","ubg76.com","ubg77.com","ubg88.com","ubg98.com",
  "ubgfun.github.io","unblocked-games-66.com","unblocked-games-76.com","unblocked-games.io","unblocked-games.net",
  "unblocked.games","unblocked.pages.dev","unblockedgames-1.com","unblockedgames-76.com","unblockedgames-world.com",
  "unblockedgames.click","unblockedgames.dev","unblockedgames.fun","unblockedgames.gg","unblockedgames.link",
  "unblockedgames.lol","unblockedgames.mom","unblockedgames.pages.dev","unblockedgames.pro","unblockedgames.school",
  "unblockedgames.top","unblockedgames007.com","unblockedgames24h.com","unblockedgames333.com","unblockedgames360.com",
  "unblockedgames444.com","unblockedgames500.com","unblockedgames555.com","unblockedgames66.com","unblockedgames66.games",
  "unblockedgames66.io","unblockedgames666.com","unblockedgames66ez.com","unblockedgames69.com","unblockedgames6969.com",
  "unblockedgames6x.com","unblockedgames76.com","unblockedgames76.io","unblockedgames77.com","unblockedgames88.com",
  "unblockedgames911.com","unblockedgames99.com","unblockedgamesaz.com","unblockedgamescenter.com","unblockedgamescool.com",
  "unblockedgamesfree.com","unblockedgameshaven.com","unblockedgameshub.com","unblockedgamesnow.com","unblockedgamespod.com",
  "unblockedgamespremium.com","unblockedgamessite.com","unblockedgamesworld.com","unblockedgameswtf.com","unblockedgameszone.com",
  "unblockedgamez.com","unblocker.cc","unblocker.win","unblockgames.org","unblockit.kim",
  "unblockit.li","unblockit.tv","unblocksites.co","unblockvideos.com","unity.com",
  "valorant.com","vanis.io","veck.io","venge.io","vimm.net",
  "virtualnes.com","virtualvacation.us","volleyballbros.io","vortex.gg","vpnsite.com",
  "waffle-game.com","wanted5.com","wanted5games.com","warbrokers.io","warin.space",
  "watermelongame.com","watermelongame.io","weavesilk.com","webgamer.io","webmc.io",
  "weboas.is","webproxy.to","wgplayer.com","wgplayground.com","whoer.net/proxy",
  "windowswap.com","wings.io","wordhurdle.io","wordle-unlimited.io","wordle.plus",
  "wordlegame.org","wordleunlimited.com","wordplay.com","worldcraft.io","worlde.org",
  "worldguessr.com","wormate.io","wormateio.com","wormaxio.com","worms.zone",
  "wowroms.com","xbox.com/play","xcloud.com","y8.com","yandex.com/games",
  "yiv.com","yohoho.io","youthfilter.com","youtubeunblocked.live","zenvpn.net",
  "zlap.io","zombs.io","zombsroyale.io","zoomquilt.org",
]);

const GAME_KEYWORDS = [
  "unblocked games","play free games","online games","browser games",
  "io games","html5 games","flash games","game online free",
  "play now","fortnite unblocked","minecraft unblocked","roblox unblocked",
  "games unblocked","school games","games at school","games for school",
  "games not blocked","unblocked game","free games online","play games at school",
  "webgl games","no download games","games without download","proxy games",
  "unblocked proxy","game proxy","how to play games at school","bypass school filter",
  "get around school wifi","unblock websites at school","school wifi bypass","vpn for school",
  "slope unblocked","1v1 lol unblocked","krunker unblocked","among us unblocked",
  "fnaf unblocked","retro bowl unblocked","run 3 unblocked","drift boss unblocked",
  "friday night funkin unblocked","snake unblocked","tetris unblocked","pac man unblocked",
  "crazy cattle 3d","cattle game","now.gg roblox","now.gg minecraft",
  "now.gg fortnite","now.gg among us","google sites games","google sites unblocked",
  "github games","replit games","chrome dino hack","dino game",
  "offline game chrome","no internet game","cool math games","math games",
  "tyrone unblocked games","tyrones unblocked games","scratch games","scratch projects games",
  "classroom 6x games","classroom6x","ubg games","play game free",
  "free browser game","eaglercraft","eaglercraft download","web proxy for games",
  "unblock game website","game not blocked at school","play at school","school chromebook games",
  "chromebook games","ipad games at school","games on school ipad","bypass web filter",
  "how to bypass school firewall","get past school blocker","website unblocker","free web proxy",
  "anonymous web proxy","crazy cattle game","drift hunters","drift hunters unblocked",
  "geometry dash online","geometry dash unblocked","monkey mart","monkey mart unblocked",
  "paper io unblocked","hole io unblocked","bloxd io","bonk io",
  "moomoo io","skibidi toilet game","skibidi game","sprunki game",
  "sprunki","incredibox sprunki","cookie clicker","cookie clicker unblocked",
  "2048 unblocked","flappy bird unblocked","fnf online","fnf mods",
  "fnf unblocked","smash karts","smash karts unblocked","basket random",
  "basket random unblocked","tunnel rush","tunnel rush unblocked","subway surfers online",
  "subway surfers unblocked","bitlife online","bitlife unblocked","buildnow gg",
  "1v1.lol unblocked","3kh0","interstellar proxy","doge unblocker",
  "emerald proxy","shadow proxy",
];

const AI_CHAT_DOMAINS = new Set([
  "chatgpt.com","chat.openai.com","openai.com",
  "claude.ai","anthropic.com",
  "gemini.google.com","bard.google.com",
  "perplexity.ai",
  "copilot.microsoft.com",
  "poe.com","character.ai","janitor.ai","you.com","phind.com",
  "huggingface.co","replika.com","chai-app.com",
  "beta.dreamstudio.ai","midjourney.com","firefly.adobe.com",
  "deepai.org","writesonic.com","jasper.ai","copy.ai",
]);

const VPN_PROXY_DOMAINS = new Set([
  "nordvpn.com","expressvpn.com","surfshark.com","cyberghost.com",
  "privateinternetaccess.com","protonvpn.com","mullvad.net","windscribe.com",
  "tunnelbear.com","hotspotshield.com","hide.me","hidemyass.com","purevpn.com","ipvanish.com",
  "pia.com","strongvpn.com","vyprvpn.com","zenmate.com","betternet.com",
  "psiphon.ca","ultrasurf.us","freegate.us","lantern.io",
  "croxyproxy.com","croxyproxy.rocks","kproxy.com","filterbypass.me",
  "unblocksite.org","proxysite.com","hidemy.name","vpnbook.com",
  "plainproxy.com","4everproxy.com","megaproxy.com","weboproxy.com",
  "unblocker.us","unblockit.dev","unblockit.pages.dev",
  "dns.google","cloudflare-dns.com","doh.dns.sb","dns.quad9.net",
  "torproject.org","onion.ly","tor2web.org",
  "browsec.com","holavpn.com","setupvpn.com","touchvpn.net",
  "1clickvpn.com","urbanvpn.com","veepn.com",
]);

const GAMBLING_DOMAINS = new Set([
  "draftkings.com","fanduel.com","betmgm.com","caesars.com","bet365.com","bovada.lv",
  "betonline.ag","mybookie.ag","pokerstars.com","888poker.com","wsop.com","partypoker.com",
  "betway.com","williamhill.com","paddypower.com","ladbrokes.com","coral.co.uk","unibet.com",
  "pointsbet.com","bwin.com","betfair.com","sportsbet.com.au","stake.com","rollbit.com",
  "roobet.com","duelbits.com","gamdom.com","csgoroll.com","primedice.com","fortunejack.com",
  "bitcasino.io","cloudbet.com","casumo.com","leovegas.com","mrgreen.com","rizk.com",
  "betsson.com","pinnacle.com","1xbet.com","22bet.com","melbet.com","mostbet.com",
  "jackpotcity.com","spinpalace.com","royalvegas.com","rubyfortune.com","gamblingsite.com",
  "casino.com","casino.org","slots.lv","ignitioncasino.eu","slotocash.im",
  "coolcat-casino.com","planetwin365.com","betfred.com","skybet.com","sportingbet.com",
  "888casino.com","888sport.com","betrivers.com","borgataonline.com","harrahscasino.com",
  "goldennuggetcasino.com","virginbet.com","wynn.com","wynnbet.com","si.sportsbook.com",
  "twinspires.com","tvg.com","xbet.ag","sportsbetting.ag","bookmaker.eu",
  "betanysports.eu","heritage.com","jazzsports.ag","betus.com.pa","gtbets.eu",
  "vegasslotsonline.com","askgamblers.com","casinomeister.com","wizardofodds.com",
  "casinotop10.net","casinopedia.org","gambling.com","vegasinsider.com",
  "oddschecker.com","oddsshark.com","actionnetwork.com","covers.com",
  "rotowire.com","numberfire.com","betql.co","lineups.com",
  "slotcatalog.com","slottracker.com","bigwinboard.com",
]);

// Gambling URL keywords — catch sites not in domain list
const GAMBLING_KEYWORDS = [
  "casino","poker","blackjack","roulette","slots","sportsbook","sportsbetting",
  "sports-betting","online-gambling","gambling","wagering","baccarat","craps",
  "slot-machine","jackpot","free-spins","no-deposit-bonus","betting-odds",
  "parlay","spread-betting","horse-racing-betting","esports-betting",
];

const ADULT_DOMAINS = new Set([
  "pornhub.com","xvideos.com","xhamster.com","xnxx.com","redtube.com","youporn.com",
  "tube8.com","spankbang.com","eporner.com","beeg.com","tnaflix.com","drtuber.com",
  "porntrex.com","hqporner.com","motherless.com","chaturbate.com",
  "stripchat.com","bongacams.com","myfreecams.com","livejasmin.com","cam4.com",
  "onlyfans.com","fansly.com","manyvids.com","clips4sale.com","brazzers.com",
]);

const SOCIAL_MEDIA_DOMAINS = new Set([
  "facebook.com","instagram.com","twitter.com","x.com","tiktok.com","snapchat.com",
  "reddit.com","tumblr.com","pinterest.com","threads.net","mastodon.social",
  "bsky.app","discord.com","kick.com",
  // TikTok app/CDN hosts (2026-09-08). matchesDomainInSet() walks parent domains,
  // so "tiktok.com" already covers www./m./vm.tiktok.com — but these are SEPARATE
  // registrable domains and were matched by nothing. The TikTok app and the web
  // player pull video from tiktokcdn*/muscdn, so blocking only tiktok.com stopped
  // the page and left the media path open.
  "tiktokcdn.com","tiktokcdn-us.com","tiktokv.com","muscdn.com",
]);

const STREAMING_DOMAINS = new Set([
  "netflix.com","hulu.com","disneyplus.com","max.com","peacocktv.com","paramountplus.com",
  "crunchyroll.com","funimation.com","pluto.tv","tubitv.com","roku.com","plex.tv",
  "primevideo.com","appletv.apple.com",
  // Spotify (2026-09-08, Excel Academy). This list was video-only, so a school
  // that ticked "Streaming" got a control that could not block Spotify by ANY
  // hostname. Excel has activity_logs rows for open.spotify.com,
  // accounts.spotify.com and spotify.com; only 2 of 30 orgs had hand-typed a
  // Spotify domain into blocked_domains while 7 orgs run the streaming category.
  // spotify.com covers open./accounts. via parent-domain matching; scdn.co and
  // spotifycdn.com are separate registrable domains and need their own entries
  // or audio keeps streaming after the web app is blocked.
  "spotify.com","scdn.co","spotifycdn.com",
]);

const DRUGS_DOMAINS = new Set([
  "erowid.org","leafly.com","weedmaps.com","grasscity.com","420magazine.com",
  "hightimes.com","theweedblog.com","royalqueenseeds.com","seedsman.com",
]);

const WEAPONS_DOMAINS = new Set([
  "gunbroker.com","armslist.com","gunsamerica.com","budsgunshop.com","palmettostatearmory.com",
  "cheaperthandirt.com","midwayusa.com","brownells.com","opticsplanet.com",
]);

// Category → domain set mapping (lowercase kebab-case to match proxy)
// ============================================================
// Ad / Tracker Domains (client-side blocking for direct connections)
// Top 500 most common ad/tracker domains — catches ads that bypass proxy
// ============================================================
const AD_TRACKER_DOMAINS = new Set([
  // Google Ads
  "doubleclick.net","googlesyndication.com","googleadservices.com",
  "adservice.google.com","pagead2.googlesyndication.com","tpc.googlesyndication.com",
  "googleads.g.doubleclick.net","ad.doubleclick.net","static.doubleclick.net",
  "adsense.google.com","www.googleadservices.com","googletagservices.com",
  // Major Ad Exchanges
  "adnxs.com","adsrvr.org","openx.net","pubmatic.com","rubiconproject.com",
  "criteo.com","criteo.net","casalemedia.com","sharethrough.com","bidswitch.net",
  "3lift.com","triplelift.com","gumgum.com","ad-delivery.net","indexww.com",
  "indexexchange.com","smaato.net","smartadserver.com","sonobi.com",
  "spotxchange.com","yieldmo.com","media.net","teads.tv","inmobi.com",
  "liveintent.com","adroll.com","stackadapt.com","contextweb.com",
  // Amazon Ads
  "amazon-adsystem.com","aax.amazon-adsystem.com","assoc-amazon.com",
  // Content Recommendation
  "outbrain.com","taboola.com","mgid.com","revcontent.com","zergnet.com",
  // Pop-ups / Malvertising
  "popads.net","popcash.net","propellerads.com","hilltopads.net","exoclick.com",
  "trafficjunky.com","trafficstars.com","adsterra.com","ad-maven.com",
  "clickadu.com","monetag.com","pushhouse.io","evadav.com","rollerads.com",
  // Video Ads
  "freewheel.tv","fwmrm.net","jwpltx.com","springserve.com",
  // Mobile Ad Networks
  "applovin.com","vungle.com","chartboost.com","ironsrc.com","tapjoy.com","adcolony.com",
  // Ad Servers
  "serving-sys.com","flashtalking.com","sizmek.com","innovid.com","zedo.com",
  "advertising.com","adform.net","adform.com","adzerk.net","addthis.com",
  "carbonads.com","buysellads.com",
  // Programmatic
  "aniview.com","connatix.com","seedtag.com","loopme.com","emxdgt.com",
  // Ad Verification
  "moatads.com","doubleverify.com","integralads.com","adsafeprotected.com",
  // Tracking
  "demdex.net","rlcdn.com","tapad.com","crwdcntrl.net","eyeota.net",
  "id5-sync.com","liadm.com","rfihub.com","mathtag.com",
  "scorecardresearch.com","quantserve.com","quantcast.com","comscore.com",
  // Social Tracking
  "connect.facebook.net","facebook.net","pixel.facebook.com",
  "platform.twitter.com","syndication.twitter.com",
  "snap.licdn.com","ct.pinterest.com","tr.snapchat.com",
  // Analytics
  "google-analytics.com","analytics.google.com","googletagmanager.com",
  "segment.io","segment.com","amplitude.com","mixpanel.com",
  "hotjar.com","fullstory.com","mouseflow.com","crazyegg.com","heap.io",
  // Session Replay
  "inspectlet.com","smartlook.com","logrocket.com","contentsquare.net",
  // Crypto Miners
  "coinhive.com","coin-hive.com","authedmine.com","crypto-loot.com",
  "jsecoin.com","minero.cc","coinimp.com","mineralt.io","webminepool.com",
  // Fingerprinting
  "fingerprintjs.com","fpjs.io",
  // Push notifications (marketing)
  "onesignal.com","pushwoosh.com","pushengage.com","webpushr.com",
  // Marketing automation
  "pardot.com","marketo.net","eloqua.com","hubspot.com",
  // Ad targeting
  "bluekai.com","bkrtx.com","lotame.com","exelator.com",
  // Additional ad servers
  "2mdn.net","btloader.com","intergient.com","ccgateway.net","hadronid.net",
  "imasdk.googleapis.com","moatpixel.com","adnxs.net",
  // Mediavine / Raptive
  "mediavine.com","raptive.com","snigelweb.com","adthrive.com","cafemedia.com",
  // Attribution
  "appsflyer.com","adjust.com","branch.io","kochava.com",
  // A/B Testing trackers
  "optimizely.com","vwo.com","abtasty.com",
  // Extended SSPs
  "sovrn.com","lijit.com","districtm.io","brightcom.com","beeswax.com",
  // Affiliate tracking
  "skimresources.com","redirectingat.com","impact.com","shareasale.com",
]);

const CATEGORY_DOMAINS = {
  "gambling": GAMBLING_DOMAINS,
  "adult-content": ADULT_DOMAINS,
  "social-media": SOCIAL_MEDIA_DOMAINS,
  "streaming": STREAMING_DOMAINS,
  "gaming": GAMING_DOMAINS,
  "ai-tools": AI_CHAT_DOMAINS,
  "generative-ai": AI_CHAT_DOMAINS,
  "ai-chat": AI_CHAT_DOMAINS,
  "proxy-vpn": VPN_PROXY_DOMAINS,
  "drugs-alcohol": DRUGS_DOMAINS,
  "weapons": WEAPONS_DOMAINS,
};

// 🔴 2026-09-04, #426 — EVERY SELECTABLE CATEGORY MUST DECLARE HOW IT IS ENFORCED.
//
// The category loop below is `const domainSet = CATEGORY_DOMAINS[cat]; if
// (!domainSet) continue;`. That made an unmapped category a SILENT NO-OP: the
// dashboard toggle went red, the policy saved, the device synced it, and
// nothing was ever blocked. 27 of the 35 selectable categories were in that
// state, including `self-harm` and `malware`.
//
// On Chromebooks this extension is the ONLY enforcement point — setupProxyRouting()
// deliberately clears proxy routing ("extension-only filtering mode") because
// managed devices hit ERR_TUNNEL_CONNECTION_FAILED. So there was no second layer
// quietly covering for these. Excel Academy had self-harm and malware enabled
// and believed they were active. That is a CIPA-relevant false claim, not a
// cosmetic gap.
//
// Two honest routes exist, and every category must name one:
//
//   "domain-set"        enforced locally against a bundled Set in CATEGORY_DOMAINS.
//                       Works offline, applied via DNR rules + checkUrl().
//   "cloud-classifier"  no bundled list; resolved per-domain by the proxy's
//                       /api/categorize (91K embedded DB + community feeds +
//                       content classifier), then enforced by checkDomainDynamic().
//
// packages/shared/src/lib/category-coverage.test.mjs FAILS if a category the
// dashboard can offer is missing here, if it claims "domain-set" without one, or
// if the classifier path discards it. Adding a 36th toggle without an
// enforcement route breaks the build — which is the only thing that stops this
// regressing as the category list grows.
const CATEGORY_ENFORCEMENT = {
  // Locally enforced — bundled domain sets.
  "gambling": "domain-set",
  "adult-content": "domain-set",
  "social-media": "domain-set",
  "streaming": "domain-set",
  "gaming": "domain-set",
  "proxy-vpn": "domain-set",
  "drugs-alcohol": "domain-set",
  "weapons": "domain-set",
  "generative-ai": "domain-set",
  "ai-chat": "domain-set",

  // Resolved by the proxy classifier. These have no bundled list — shipping a
  // credible offline malware/self-harm list in an extension bundle is not
  // feasible, so they are enforced against the server-side database instead.
  "ai-coding": "cloud-classifier",
  "ai-image": "cloud-classifier",
  "violence": "cloud-classifier",
  "self-harm": "cloud-classifier",
  "malware": "cloud-classifier",
  "fraud": "cloud-classifier",
  "abuse": "cloud-classifier",
  "piracy": "cloud-classifier",
  "crypto": "cloud-classifier",
  "shopping": "cloud-classifier",
  "yt-gaming": "cloud-classifier",
  "yt-music": "cloud-classifier",
  "yt-entertainment": "cloud-classifier",
  "yt-sports": "cloud-classifier",
  "yt-news": "cloud-classifier",
  "yt-howto": "cloud-classifier",
  "yt-comedy": "cloud-classifier",
  "yt-people": "cloud-classifier",
  "yt-science": "cloud-classifier",
  "yt-education": "cloud-classifier",
  "yt-film": "cloud-classifier",
  "yt-autos": "cloud-classifier",
  "yt-pets": "cloud-classifier",
  "yt-travel": "cloud-classifier",
  "yt-nonprofit": "cloud-classifier",
};

// Categories whose classifier verdict must never trigger a block, regardless of
// policy. These are not blockable categories — they are the classifier's way of
// saying "this is fine".
//
// ⚠️ 2026-09-04 — this list used to include "shopping", which IS a selectable
// policy category. A school that blocked Shopping had every classifier verdict
// for it thrown away. Anything an admin can tick must not appear here; the test
// suite enforces that.
const CLASSIFIER_SAFE_CATEGORIES = new Set([
  "safe",
  "education",
  "news",
  "reference",
  "technology",
]);

function shouldIgnoreClassifierCategory(cat) {
  if (!cat) return true;
  return CLASSIFIER_SAFE_CATEGORIES.has(cat);
}

// ============================================================
// State
// ============================================================

const AGENT_VERSION = chrome.runtime.getManifest().version;
let config = { orgId: "", deviceId: "", deviceName: "", enrolled: false, userEmail: "" };
let policy = {
  blockedDomains: [], blockedCategories: [], blockedKeywords: [],
  allowedDomains: [], safeSearch: false, blockGames: true,
  disableAIOverview: false,
  distractionHidingEnabled: false,
  schoolHours: null, schoolDays: null, timezone: null,
};

// 🔴 2026-09-01 — COLD-START FAIL-OPEN GATE. Excel Academy reported a domain that
// sits in SIX of their policies being reachable. It was not a proxy bypass and
// not an entry-shape miss: production activity_logs held, for one navigation,
// BOTH an `allowed` row and a `blocked` row for the same domain on the same
// device 0–240 ms apart. 20 of 21 `allowed` rows for that domain were paired
// that way. The dashboard rendered the allowed copy, so it looked like a bypass.
//
// Cause: `policy` above initialises with an EMPTY blocklist, and is only filled
// in by an async cached read + async syncPolicies(). The webNavigation listeners
// are registered SYNCHRONOUSLY at module load. MV3 evicts an idle service worker
// after ~30s and respawns it ON the navigation event — so the first navigation
// after every respawn can be evaluated against `blockedDomains: []`.
//
// That window is a genuine fail-open, not just a logging artifact: a domain that
// exists ONLY in org policy (not in the builtin GAMING_DOMAINS/category sets) has
// nothing to catch it, and the request is allowed until the retry.
//
// `policyReady` stays false until a policy is actually loaded from cache or
// network. checkUrl() marks verdicts taken before that as `policyPending` so the
// enforcement path can decline to treat them as a clean allow, and so the
// activity log never records a phantom `allowed` row for a blocked site.
//
// ⚠️ DELIBERATELY NOT FAIL-CLOSED. A device that has never synced and has no cache
// (first enrolment on a dead network) still passes traffic. Blocking everything
// there would take out a classroom on a flaky wifi morning, which is a worse and
// far more visible failure than the window this closes. What changes is that the
// window no longer LIES: the verdict is marked pending and is not recorded as an
// administrative "allowed".
//
// Always assign through setPolicy() — never `policy = ...` directly. The flag and
// the data must move together; a site that sets one without the other silently
// reintroduces the exact fail-open this closes.
let policyReady = false;

/** Install a loaded policy and mark enforcement ready. */
function setPolicy(next) {
  policy = next;
  policyReady = true;
  return policy;
}

/**
 * Is a real policy in force?
 *
 * True when sync/cache marked us ready, OR when `policy` already carries rules.
 * The second clause is the safety net: it derives readiness from the DATA rather
 * than from a flag someone forgot to set, so no future assignment path can
 * silently reopen the fail-open window.
 */
function policyLoaded() {
  if (policyReady) return true;
  const p = policy || {};
  return (
    (p.blockedDomains && p.blockedDomains.length > 0) ||
    (p.allowedDomains && p.allowedDomains.length > 0) ||
    (p.blockedCategories && p.blockedCategories.length > 0) ||
    (p.blockedKeywords && p.blockedKeywords.length > 0)
  );
}
// KyberPulse config — remote terms override defaults on next policy sync
let pulseConfig = { checks: null, enabled: true };
let stats = { blocked: 0, allowed: 0 };

// ── WebSocket Policy Push ──
let wsConn = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000; // Start at 1s, exponential backoff to 60s

function connectPolicyWebSocket() {
  if (!config.enrolled || !config.orgId) return;
  if (wsConn && wsConn.readyState === WebSocket.OPEN) return;

  try {
    const wsUrl = PROXY_BASE.replace("https://", "wss://").replace("http://", "ws://");
    const params = new URLSearchParams({
      orgId: config.orgId,
      deviceId: config.deviceId || "",
      email: config.userEmail || "",
    });
    wsConn = new WebSocket(`${wsUrl}/ws?${params}`);

    wsConn.onopen = () => {
      console.log("🔌 WS connected for policy push");
      wsReconnectDelay = 1000; // Reset backoff on successful connect
    };

    wsConn.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "policyUpdate") {
          console.log(`📡 WS policy push received: v${msg.policyVersion}`);
          // Instant policy refresh
          await syncPolicies();
        } else if (msg.type === "connected") {
          console.log(`🔌 WS confirmed: server policy v${msg.policyVersion}`);
          // Check if we're behind
          const cached = await chrome.storage.local.get(["policyVersion"]);
          if (!cached.policyVersion || cached.policyVersion < msg.policyVersion) {
            await syncPolicies();
          }
        }
      } catch (e) {
        console.error("WS message parse error:", e);
      }
    };

    wsConn.onclose = () => {
      console.log("🔌 WS disconnected, reconnecting in", wsReconnectDelay / 1000, "s");
      wsConn = null;
      const jitter = Math.random() * wsReconnectDelay * 0.3;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60000); // Cap at 60s
        connectPolicyWebSocket();
      }, wsReconnectDelay + jitter);
    };

    wsConn.onerror = (e) => {
      console.error("WS error:", e);
      // onclose will fire after onerror, triggering reconnect
    };
  } catch (e) {
    console.error("WS connect failed:", e);
    wsReconnectTimer = setTimeout(connectPolicyWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 60000);
  }
}
let deviceState = {
  currentURL: "",
  currentTitle: "",
  currentFavicon: "",
  currentApp: "Google Chrome",
  activeTabId: null,
  lastTabUpdate: 0,
  lastCommandType: "",
  lastCommandAt: "",
  lastSessionAckAt: "",
  _lastPushedURL: null,
};

// ============================================================
// Init
// ============================================================

// Restore state on every service worker wake (covers idle termination restarts,
// not just onInstalled/onStartup which don't fire on idle-restart)
//
// 🔴 2026-08-29 — THIS BLOCK RESTORED STATE BUT NOT THE CAPTURE TIMERS.
//
// Excel Academy (first paying customer): "The teacher waits 15 minutes and it
// doesn't actually show."
//
// MV3 kills an idle service worker after ~30s, taking every setInterval with it.
// onInstalled and onStartup both call startScreenViewMonitoring() + startHeartbeat()
// — but NEITHER FIRES ON AN IDLE RESTART. This IIFE is the only code that runs on
// every wake, and it restored config, stats, policy and the WebSocket while leaving
// screenshot capture and heartbeat dead. The sole remaining recovery path was the
// `screenshotBackup` alarm, which Chrome clamps to a 1-minute minimum and delays
// further on idle/battery Chromebooks — and which only runs if something else woke
// the worker first.
//
// So the intended 15s capture cadence silently degraded to "whenever a navigation
// or an alarm happens to wake the worker". MEASURED ON PROD, Excel, in-session
// weekday hours only (Thu 08-27 + Fri 08-28, 08:00–15:00 ET — a Saturday figure
// would be a weekend artifact):
//
//   • 1,470 reporting gaps >5 min and 836 gaps >15 min, across 204 of 261 active
//     devices — 78% of the fleet
//   • MEDIAN long gap 19.2 minutes; worst 289 minutes
//   • ~22 events/device/school-day vs ~840 expected from the 0.5-min heartbeat
//     alarm across a 7-hour day — a ~97% shortfall
//
// That median is the teacher's "15 minutes", measured.
//
// Restarting capture here is safe against double-start: startScreenViewMonitoring()
// guards on BOTH the live interval and the pending 5s settle timer (see 6dc9087),
// and it is a no-op while a classroom session owns the faster 4s capture.
(async () => {
  await loadConfig();
  await loadStats();
  if (config.enrolled) {
    // Restore cached policy from storage
    const cached = await chrome.storage.local.get(["policy", "classroomMode", "lockMessage", "isDeviceLocked", "classroomLeaseExpiresAt"]);
    // The cached policy is the fast path that closes the respawn fail-open window:
    // it is available in ~1ms, long before the network sync returns.
    if (cached.policy) setPolicy({ ...policy, ...cached.policy });
    // 🔴 LEASE GATE (#551) on WAKE. This is one of the two places that re-armed
    // enforcing state straight out of storage with no expiry check, so on a
    // device evicted every ~30s a stranded lock was re-asserted on every wake,
    // forever. Restore the lock only while its lease is still valid; an expired
    // lease leaves the device on normal org policy, which still filters.
    if (
      (cached.isDeviceLocked || cached.classroomMode === "locked") &&
      isClassroomLeaseValid(cached)
    ) {
      isDeviceLocked = true;
    }
    // Kick off async refresh
    syncPolicies();
    connectPolicyWebSocket();
    // 🔴 The load-bearing lines: without these the worker wakes blind and the
    // dashboard shows a frame from before it died.
    startHeartbeat();
    startScreenViewMonitoring();
    // 🔴 2026-09-01 (#202) — THE THIRD EVICTION-SENSITIVE TIMER.
    //
    // #32/7c43885 re-armed capture and heartbeat here and stopped there.
    // startCommandPolling() was called from exactly one place — the "Joined a
    // new session" branch (~:2403) — so on any device NOT mid-classroom-session
    // the 3s teacher-command loop died with the worker and never came back.
    // Delivery fell to the `commandPoll` alarm, which Chrome clamps to a 30s
    // floor AND which fired a single poll rather than restoring the cadence:
    // a permanent 10x latency regression for the rest of the browsing session.
    //
    // Excel Academy, measured 2026-09-01: p50 closeTab 19.2s, 23 of 33 acked
    // commands in the 10-35s band. That band is the alarm floor. The teacher's
    // "I don't feel as if it reacts" is that number.
    //
    // The device most likely to have an evicted worker is an IDLE one — exactly
    // the off-task-tab case a teacher is trying to act on.
    //
    // Safe on every wake: startCommandPolling() calls stopCommandPolling()
    // first and fires an immediate poll before arming the interval.
    startCommandPolling();
  }
})();

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  if (!config.enrolled) {
    // Check for managed policy (Google Admin auto-config)
    try {
      const managed = await chrome.storage.managed.get(["orgId", "deviceName"]);
      if (managed.orgId) {
        console.log("🏫 Auto-enrolling from managed policy:", managed.orgId);
        await enroll(managed.orgId, managed.deviceName || "Managed Chromebook");
      }
    } catch (e) { console.log("No managed storage:", e); }
  }
  if (config.enrolled) {
    await detectAndAssignUser();
    await syncPolicies();
    await setupProxyRouting();
    startHeartbeat();
    startScreenViewMonitoring();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  await loadStats();
  if (config.enrolled) {
    await detectAndAssignUser();
    await syncPolicies();
    await setupProxyRouting();
    startHeartbeat();
    startScreenViewMonitoring();
  }
});

// Auto-detect signed-in Google user and assign to device
async function detectAndAssignUser() {
  try {
    const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    if (userInfo && userInfo.email && userInfo.email !== config.userEmail) {
      config.userEmail = userInfo.email;
      await chrome.storage.sync.set({ userEmail: userInfo.email });
      // Update device record in database
      if (config.orgId && config.deviceId) {
        await api.updateDevice(config.orgId, config.deviceId, {
          userEmail: userInfo.email,
          platform: "Chrome",
          version: AGENT_VERSION || "2.36.0",
          timestamp: new Date().toISOString(),
        });
        console.log("👤 User assigned:", userInfo.email);
      }
    }
  } catch (e) {
    console.log("Could not detect user:", e);
  }
}

// ============================================================
// Config & Stats
// ============================================================

async function loadConfig() {
  const data = await chrome.storage.sync.get(["orgId", "deviceId", "deviceName", "userEmail"]);
  config = {
    orgId: data.orgId || "",
    deviceId: data.deviceId || "",
    deviceName: data.deviceName || "",
    userEmail: data.userEmail || "",
    enrolled: !!data.orgId,
  };
}

async function loadStats() {
  const data = await chrome.storage.local.get(["blocked", "allowed"]);
  stats.blocked = data.blocked || 0;
  stats.allowed = data.allowed || 0;
  // Restore cached pulse config on startup
  const cached = await chrome.storage.local.get("pulseConfig");
  if (cached.pulseConfig) {
    pulseConfig = cached.pulseConfig;
  }
}

// ============================================================
// Enrollment
// ============================================================

async function enroll(orgId, deviceName) {
  const deviceId = crypto.randomUUID();

  // Auto-detect device name if not provided
  if (!deviceName || deviceName === "Chrome Device") {
    try {
      const platformInfo = await chrome.runtime.getPlatformInfo();
      const osMap = { win: "Windows", mac: "Mac", cros: "Chromebook", linux: "Linux" };
      const osName = osMap[platformInfo.os] || platformInfo.os;
      // Try to get hostname via managed policy or fall back to OS + random suffix
      const managed = await chrome.storage.managed.get(["deviceName"]).catch(() => ({}));
      if (managed.deviceName) {
        deviceName = managed.deviceName;
      } else {
        deviceName = `${osName}-${deviceId.slice(0, 6).toUpperCase()}`;
      }
    } catch {
      deviceName = `Device-${deviceId.slice(0, 6).toUpperCase()}`;
    }
  }

  config = { orgId, deviceId, deviceName, enrolled: true, userEmail: "" };
  await chrome.storage.sync.set({ orgId, deviceId, deviceName: config.deviceName });

  // Gather device info
  const ua = navigator.userAgent;
  const chromeVer = ua.match(/Chrome\/(\d+)/)?.[1] || "unknown";
  const platformInfo = await chrome.runtime.getPlatformInfo().catch(() => ({ os: "unknown", arch: "unknown" }));
  const osMap = { win: "Windows", mac: "macOS", cros: "ChromeOS", linux: "Linux" };
  const osLabel = osMap[platformInfo.os] || platformInfo.os;
  const platform = navigator.userAgentData
    ? (await navigator.userAgentData.getHighEntropyValues(["platform", "platformVersion"])).platform
    : navigator.platform;

  await api.updateDevice(orgId, deviceId, {
    userEmail: config.userEmail || "",
    platform: `${osLabel} · Chrome ${chromeVer}`,
    version: AGENT_VERSION,
    timestamp: new Date().toISOString(),
  });

  await syncPolicies();
  await setupProxyRouting();
  startHeartbeat();
  startClassroomPoll();
  startScreenViewMonitoring(); // Always-on ScreenView screenshot capture
  connectPolicyWebSocket(); // WebSocket for instant policy push
  // Start location tracking
  updateLocationAlarm();
  setTimeout(reportLocation, 3000);
  return { orgId, deviceId };
}

async function unenroll() {
  if (config.enrolled) {
    await api.updateDevice(config.orgId, config.deviceId, {
      userEmail: config.userEmail || "",
      platform: "Chrome",
      version: AGENT_VERSION,
      timestamp: new Date().toISOString(),
    });
  }
  config = { orgId: "", deviceId: "", deviceName: "", enrolled: false, userEmail: "" };
  policy = { blockedDomains: [], blockedCategories: [], blockedKeywords: [], allowedDomains: [], safeSearch: false, blockGames: true, disableAIOverview: false, distractionHidingEnabled: false, schoolHours: null, schoolDays: null, timezone: null };
  await chrome.storage.sync.remove(["orgId", "deviceId", "deviceName", "userEmail"]);
  await clearProxyRouting();
}

// ============================================================
// Policy Sync — via Proxy API (Postgres-backed policy sync)
// ============================================================

// ============================================================
// Proxy Routing — Route all traffic through KyberGate proxy
// ============================================================
// This is critical: without proxy routing, the extension can only
// block navigations it intercepts. The proxy provides the full
// 8-layer blocking stack: 91K domain DB, MITM content analysis,
// game detection engine, keyword filtering, category blocking.

async function setupProxyRouting() {
  // Proxy routing disabled — Chrome Extension handles filtering via webRequest/webNavigation APIs.
  // On managed Chromebooks, chrome.proxy is often blocked by enterprise policy and causes
  // ERR_TUNNEL_CONNECTION_FAILED when the proxy port is unreachable.
  // Clear any previously-set proxy to fix Chromebooks stuck in broken proxy state.
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
    console.log("🌐 Proxy routing cleared (extension-only filtering mode)");
  } catch (e) {
    // Ignore - may not have permission
  }
  // Still register with proxy API for device tracking/screenshots
  if (!config.enrolled || !config.orgId) return;
  try {
    const pacUrl = `${PROXY_BASE}/api/pac/${config.orgId}?email=${encodeURIComponent(config.userEmail || "")}&udid=${encodeURIComponent(config.deviceId || "")}&name=${encodeURIComponent(config.deviceName || "")}`;
    await fetch(pacUrl).catch(() => {});
    console.log("📡 Device registered with proxy (no routing):", pacUrl);
  } catch (e) {}
}

async function clearProxyRouting() {
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
    console.log("🌐 Proxy routing cleared");
  } catch (e) {
    console.error("⚠️ Proxy clear failed:", e.message);
  }
}

async function syncPolicies() {
  if (!config.enrolled) return;
  try {
    const params = new URLSearchParams({
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      email: config.userEmail,
    });
    const res = await fetch(`${PROXY_BASE}/api/policy/${config.orgId}?${params}`);
    if (!res.ok) throw new Error(`Policy fetch failed: ${res.status}`);
    const data = await res.json();

    // ── Schedule verdict (#449) ──
    // Refreshed on EVERY sync, including the unchanged-version short-circuit
    // below. The verdict is time-sensitive and expires on a TTL, so it cannot
    // ride on policyVersion: an org whose policy has not changed all day still
    // crosses its school-hours boundary and still needs a fresh answer.
    setScheduleVerdict(data.scheduleVerdict);

    // Check policy version — skip full parse if unchanged
    const newVersion = data.policyVersion || 0;
    const cached = await chrome.storage.local.get(["policyVersion", "dnrRulesVersion"]);
    if (cached.policyVersion && cached.policyVersion === newVersion) {
      // Server confirmed our cached policy is current — that is a successful load.
      policyReady = true;
      // Policy unchanged — but ensure DNR rules exist for this version
      // (handles extension upgrade where rules were never generated)
      if (cached.dnrRulesVersion !== newVersion) {
        await updateDynamicBlockRules();
        await chrome.storage.local.set({ dnrRulesVersion: newVersion });
      }
      return; // No changes
    }

    policy = {
      blockedDomains: data.blockedDomains || [],
      blockedCategories: data.blockedCategories || [],
      blockedKeywords: data.blockedKeywords || [],
      allowedDomains: data.allowedDomains || [],
      safeSearch: data.safeSearch || false,
      blockGames: data.blockGames !== false,
      blockAds: data.blockAds !== false,
      disableAIOverview: data.disableAIOverview || false,
      // 🔴 2026-08-17: blocked.html used to render "Request Access" unconditionally
      // because these two settings were never synced to the client. Excel Academy
      // had the feature OFF and still collected 26 requests in one day.
      // ⚠️ Default TRUE to match the server's fail-open gate: an org with no custom
      // block page config keeps its request button. `!== false` (not `|| true`) so an
      // explicit false survives.
      allowRequestUnblock: data.allowRequestUnblock !== false,
      denyRequestCategories: Array.isArray(data.denyRequestCategories) ? data.denyRequestCategories : [],
      distractionHidingEnabled: data.distractionHidingEnabled || false,
      schoolHours: data.schoolHours || null,
      schoolDays: data.schoolDays || null,
      timezone: data.timezone || null,
    };

    setPolicy(policy);
    await chrome.storage.local.set({ policy, lastPolicySync: Date.now(), policyVersion: newVersion });

    // Cache org-level settings for options page (disconnect control, etc.)
    const orgSettings = {
      allowUnenroll: data.allowUnenroll === true, // default: false (locked)
    };
    await chrome.storage.local.set({ orgSettings });

    console.log(`📋 Policy synced v${newVersion}:`, policy.blockedCategories.length, "categories,",
      policy.blockedDomains?.length || 0, "domains,",
      policy.blockedKeywords?.length || 0, "keywords");
  } catch (e) {
    console.error("Policy sync failed, using cache:", e);
    const cached = await chrome.storage.local.get("policy");
    // A cached policy is a real policy — an offline/flaky-network device must keep
    // enforcing the last known rules rather than sit in the pending state forever.
    if (cached.policy) setPolicy(cached.policy);

    // 🔴 #449 — the schedule verdict is deliberately NOT restored from cache here.
    // Blocklists survive going offline; a TIME-dependent verdict must not. If the
    // last verdict is still within its TTL it stays valid in memory on its own;
    // once it lapses, isDuringSchoolHours() returns true and the device filters.
    // OFFLINE DEFAULTS TO FILTERING. Re-seeding a verdict from storage here would
    // hand a student an offline bypass: pull the network, keep a stale
    // "outside school hours" answer alive indefinitely.
  }

  // Update dynamic DNR block rules to match the new policy
  await updateDynamicBlockRules();
  try {
    const { policyVersion } = await chrome.storage.local.get(["policyVersion"]);
    await chrome.storage.local.set({ dnrRulesVersion: policyVersion || 0 });
  } catch {}

  // Sync KyberPulse terms from proxy API (remote overrides built-in defaults)
  await syncPulseConfig();
}

// ============================================================
// declarativeNetRequest — dynamic block rules from policy
// Static rules (rules/static_blocks.json) cover hardcoded
// adult/gambling domains. Dynamic rules cover policy-specific
// blockedDomains and (when enabled) gaming domains. DNR rules
// execute synchronously BEFORE the request, so pages never load
// (unlike webNavigation.onBeforeNavigate which is informational).
// ============================================================

const DNR_DYNAMIC_RULE_CAP = 4900; // Chrome dynamic rule limit is 5000 — stay under

// Is this entry safe to hand to DNR as `||<entry>^`?
//
// 2026-09-01, Excel Academy — "tiktok should be blocked and isn't".
// One policy entry read `*tiktok.com` (wildcard, no dot). That produced the
// urlFilter `||*tiktok.com^`, and Chrome rejects it outright:
//   "A pattern beginning with ||* is not allowed."
// updateDynamicRules() is ATOMIC — "either all specified rules are added and
// removed, or an error is returned" — so that ONE entry rejected the ENTIRE
// batch. All 1078 of Excel's blocked domains lost DNR enforcement, not just
// TikTok. The catch below logged it to a service-worker console nobody reads,
// and enforcement silently fell back to the JS webRequest path, which dies with
// the MV3 worker (issue #32, ~78% of devices report nothing).
//
// So: never let one malformed row cost the org its whole blocklist. Skip the
// bad entry, keep every good one. Mirrors isValidDnrDomain in
// api/src/lib/domain-entry.js — keep the two in sync.
function isValidDnrDomain(entry) {
  const e = String(entry || "").trim().toLowerCase();
  if (!e) return false;
  // Any "*" is refused, not just a leading one — a mid-pattern "*" (e.g.
  // "ti*ok.com") is syntactically legal DNR and would become a live,
  // overly-broad rule rather than a dead one. Keep in sync with
  // api/src/lib/domain-entry.js.
  if (e.includes("*")) return false;
  if (e.includes("/")) return false;
  if (/[\s^|]/.test(e)) return false;
  if (e.includes(":")) return false;
  if (!e.includes(".")) return false;
  if (/[^\x21-\x7e]/.test(e)) return false;
  return true;
}

// ── TLD-WIDE BLOCKS ("*.io") ────────────────────────────────────────────────
//
// 2026-09-05. Schools asked to block an entire domain ending. Chromebook-only
// orgs run with the proxy deliberately OFF, so THIS FILE is their whole
// enforcement story — the proxy has always matched "*.io" correctly, but for a
// Chromebook fleet that is irrelevant.
//
// ⚠️ isValidDnrDomain() ABOVE STILL REFUSES EVERY "*", AND MUST.
// That guard is what stopped the 2026-09-01 Excel outage from recurring, and
// its reasoning has not changed: a mid-label "*" ("ti*ok.com") builds a LIVE,
// overly broad rule, and a leading "||*" makes Chrome reject the whole atomic
// batch. Nothing below relaxes it. TLD entries take a SEPARATE, narrower path
// with its own validation, and an entry that fails it is pushed to `skipped`
// exactly like any other malformed row — one bad row must never cost the org
// its blocklist.
//
// WHY regexFilter AND NOT urlFilter.
// The obvious "||io^" does not work: `||` anchors to a DOMAIN NAME and Chrome
// matches it against the host as a whole, so it would block the host literally
// named "io" and nothing else. There is no urlFilter syntax for "any host under
// this ending", so the rule has to be an anchored regex.
//
// The anchoring IS the safety property, so it is spelled out:
//   ^[a-z]+://          scheme
//   ([^/?#]*\.)?        optional subdomains, each ending in a literal dot
//   io                  the TLD
//   (:\d+)?             optional port
//   ([/?#]|$)           END OF HOST — slash, query, fragment, or nothing
// That last group is what makes it safe. Without it the pattern also matches
// "figma.iodine.com", because "io" sits at a label boundary followed by more
// characters. And `[^/?#]*` cannot cross into the path, so
// "example.com/download.io" has no ".io" in its HOST and does not match.
// Both are pinned in test/dnr-tld-enforcement.test.js.
const DNR_TLD_REGEX_CAP = 200; // Chrome's regex-rule ceiling is 1000 — stay far inside

// Mirrors TLD_LABEL_RE / PROTECTED_TLDS / RESERVED_TLDS in
// api/src/lib/domain-entry.js. Restated rather than imported: a service worker
// cannot reach the API's modules. The API is the authority and nothing invalid
// should ever arrive here, so this is defence in depth — and deliberately the
// stricter of the two. If they ever disagree the entry is skipped and reported,
// never enforced on a guess.
const DNR_PROTECTED_TLDS = new Set(["com", "org", "net", "edu", "gov"]);
const DNR_RESERVED_TLDS = new Set([
  "local", "localhost", "internal", "intranet", "corp", "home", "lan",
  "example", "invalid", "test",
]);

// The TLD a "*.<tld>" entry covers, or null when the entry is not a TLD block
// or names an ending we refuse to enforce.
function tldOfEntry(entry) {
  const e = String(entry || "").trim().toLowerCase();
  if (!e.startsWith("*.")) return null;
  const label = e.slice(2);
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(label)) return null;
  if (DNR_PROTECTED_TLDS.has(label) || DNR_RESERVED_TLDS.has(label)) return null;
  return label;
}

function isTldEntry(entry) {
  return tldOfEntry(entry) !== null;
}

// Build the anchored regex for one TLD. `label` has already passed tldOfEntry,
// so it is alphabetic (or punycode) and needs no escaping — asserted in the
// test suite, so loosening the label rule later cannot quietly turn this into
// an injection point.
function tldRegexFilter(label) {
  return `^[a-z]+://([^/?#]*\\.)?${label}(:\\d+)?([/?#]|$)`;
}

async function updateDynamicBlockRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const rules = [];
    let id = 10000; // Start after static rule IDs
    const skipped = [];

    // Allow rules for org allowlist — higher priority than dynamic blocks
    // (mirrors the allowedDomains override in the JS-based check)
    for (const domain of (policy.allowedDomains || [])) {
      if (rules.length >= DNR_DYNAMIC_RULE_CAP) break;
      if (domain && domain.includes("/")) continue;
      if (domain && !isValidDnrDomain(domain)) { skipped.push(domain); continue; }
      if (domain) {
        rules.push({
          id: id++,
          priority: 10,
          action: { type: "allow" },
          condition: {
            urlFilter: `||${domain}^`,
            resourceTypes: ["main_frame", "sub_frame"],
          },
        });
      }
    }

    // Add blocked domains from policy
    //
    // Path entries ("google.com/logos") are intentionally NOT given a DNR rule:
    // urlFilter's `||host^` form is host-scoped and cannot express a path prefix
    // reliably. They are enforced instead by checkUrl() -> matchesDomainUrl() on the
    // webRequest/webNavigation path, which sees the full URL. Skipping here is
    // correct; dropping them ENTIRELY was the bug (2026-08-18).
    for (const domain of (policy.blockedDomains || [])) {
      if (rules.length >= DNR_DYNAMIC_RULE_CAP) break;
      // Path rules are handled in checkUrl(); malformed entries are dropped
      // individually so they cannot reject the whole atomic update.
      if (domain && domain.includes("/")) continue;
      // A TLD-wide entry ("*.io") is handled by its own regexFilter pass below.
      // It must be skipped HERE rather than falling through to isValidDnrDomain,
      // which refuses every "*" — otherwise a rule the admin deliberately
      // created would be reported to the server as a malformed entry.
      if (isTldEntry(domain)) continue;
      if (domain && !isValidDnrDomain(domain)) { skipped.push(domain); continue; }
      if (domain) {
        rules.push({
          id: id++,
          priority: 2,
          action: {
            type: "redirect",
            redirect: { extensionPath: `/blocked.html?domain=${encodeURIComponent(domain)}&category=policy` },
          },
          condition: {
            urlFilter: `||${domain}^`,
            resourceTypes: ["main_frame", "sub_frame"],
          },
        });
      }
    }

    // ── TLD-wide blocks, e.g. "*.io" ──────────────────────────────────────
    //
    // Separate pass, separate validation, same priority. Priority stays 2 —
    // identical to blockedDomains, categories and gaming — so the allowlist at
    // priority 10 keeps overriding it. A school that blocks the whole .io
    // ending but allow-lists one .io tool keeps that exemption, which is the
    // only thing that makes a rule this broad usable at all. Pinned by
    // "an allowlisted .io host survives a *.io block" in
    // test/dnr-tld-enforcement.test.js.
    let tldRuleCount = 0;
    for (const domain of (policy.blockedDomains || [])) {
      if (!String(domain || "").trim().startsWith("*.")) continue;
      const label = tldOfEntry(domain);
      if (!label) {
        // A "*." entry this layer will not enforce: a protected ending
        // ("*.com"), a reserved one ("*.local"), or an ordinary wildcard domain
        // ("*.example.com") — that last one is already covered by the pass
        // above via isValidDnrDomain, so it is not reported twice.
        if (String(domain).slice(2).includes(".")) continue;
        skipped.push(domain);
        continue;
      }
      if (rules.length >= DNR_DYNAMIC_RULE_CAP) break;
      // Chrome caps REGEX rules separately from dynamic rules (1000 vs 5000)
      // and rejects the whole atomic batch on overflow. Stopping early costs
      // this one rule; overflowing would cost every rule in the update.
      if (tldRuleCount >= DNR_TLD_REGEX_CAP) { skipped.push(domain); continue; }
      rules.push({
        id: id++,
        priority: 2,
        action: {
          type: "redirect",
          redirect: { extensionPath: `/blocked.html?domain=${encodeURIComponent(domain)}&category=policy` },
        },
        condition: {
          regexFilter: tldRegexFilter(label),
          resourceTypes: ["main_frame", "sub_frame"],
        },
      });
      tldRuleCount++;
    }

    // Add blocks for every CATEGORY the org has turned on.
    //
    // Excel Academy, 2026-09-04 — "TikTok should be blocked and isn't".
    // checkUrl() blocked tiktok.com correctly (social-media is on, and
    // tiktok.com is in SOCIAL_MEDIA_DOMAINS), but nothing here ever translated
    // blockedCategories into DNR rules. checkUrl only runs on the
    // webRequest/webNavigation path, which dies with the MV3 service worker
    // (issue #32, ~78% of devices report nothing) — so a blocked category was
    // enforced only while the worker happened to be alive. Prod showed the
    // signature plainly: www.tiktok.com allowed 19 / blocked 21 on the same 51
    // devices in 48h. Explicit blockedDomains rows did not leak, because they
    // DO get rules above; that asymmetry is the whole bug.
    //
    // Priority stays 2, identical to blockedDomains and gaming, so the
    // allowlist at priority 10 keeps overriding a category block — a school
    // that deliberately permits one social host does not lose that exemption.
    for (const cat of (policy.blockedCategories || [])) {
      const domainSet = CATEGORY_DOMAINS[cat];
      if (!domainSet) continue; // category with no domain set — nothing to enforce
      for (const domain of domainSet) {
        if (rules.length >= DNR_DYNAMIC_RULE_CAP) break;
        if (domain.includes("/")) continue; // urlFilter needs a bare host
        if (!isValidDnrDomain(domain)) { skipped.push(domain); continue; }
        rules.push({
          id: id++,
          priority: 2,
          action: {
            type: "redirect",
            redirect: { extensionPath: `/blocked.html?domain=${encodeURIComponent(domain)}&category=${encodeURIComponent(cat)}` },
          },
          condition: {
            urlFilter: `||${domain}^`,
            resourceTypes: ["main_frame", "sub_frame"],
          },
        });
      }
    }

    // Add gaming domain blocks if gaming is blocked (org-configurable,
    // so gaming lives in dynamic rules — not the static ruleset)
    if (policy.blockGames) {
      for (const domain of GAMING_DOMAINS) {
        if (rules.length >= DNR_DYNAMIC_RULE_CAP) break;
        if (domain.includes("/")) continue; // urlFilter needs a bare domain
        // Validate these too. GAMING_DOMAINS is a hardcoded list in this file,
        // so it "cannot" contain a bad entry — which is exactly what was
        // assumed about policy blocklists before 2026-09-01. One typo added to
        // this array in a future edit would void the ruleset for every org that
        // has game blocking on, which is most of them (it defaults ON).
        if (!isValidDnrDomain(domain)) { skipped.push(domain); continue; }
        rules.push({
          id: id++,
          priority: 2,
          action: {
            type: "redirect",
            redirect: { extensionPath: `/blocked.html?domain=${encodeURIComponent(domain)}&category=gaming` },
          },
          condition: {
            urlFilter: `||${domain}^`,
            resourceTypes: ["main_frame", "sub_frame"],
          },
        });
      }
    }

    // ── YouTube Restricted Mode ────────────────────────────────────────────
    // Enforced with the YouTube-Restrict REQUEST HEADER, the mechanism Google
    // documents for networks/managed devices. Values: "Strict" | "Moderate".
    //
    // This REPLACES an earlier hostname rewrite to restrict.youtube.com, which
    // sent every YouTube navigation to a 404 (that name is a DNS CNAME target,
    // not a browsable host). Reported by St. Michael's 2026-08-06.
    //
    // ⚠️ Must live INSIDE this function: the commit below removes ALL existing
    // dynamic rules, so a header rule added anywhere else would be swept away on
    // the next policy sync and Restricted Mode would silently stop applying.
    if (policy.safeSearch) {
      rules.push({
        id: id++,
        priority: 20, // above allow(10)/block(2) so it always applies
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "YouTube-Restrict", operation: "set", value: "Strict" },
          ],
        },
        condition: {
          requestDomains: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtubei.googleapis.com"],
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"],
        },
      });
    }

    // Clear old dynamic rules and set new ones
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existingRules.map((r) => r.id);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: removeIds,
        addRules: rules,
      });
    } catch (e) {
      // Last-resort salvage. If Chrome still rejects the batch, a rule we did
      // not anticipate is malformed — and failing here means ZERO network-layer
      // enforcement for the whole org. Re-apply one at a time so the fleet keeps
      // every rule that IS valid, and report what was dropped.
      console.error("DNR batch rejected, falling back to per-rule apply:", e.message);
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
      let applied = 0;
      for (const rule of rules) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
          applied++;
        } catch (inner) {
          // A TLD rule has no urlFilter, so report whichever condition it
          // carries — reading only urlFilter would push `undefined`, and
          // reportDnrSkipped filters falsy entries, so a rejected TLD rule
          // would vanish from the salvage report entirely.
          skipped.push(rule.condition && (rule.condition.urlFilter || rule.condition.regexFilter));
        }
      }
      console.warn(`DNR salvage: applied ${applied}/${rules.length} rules`);
      // Report the COUNTS as well as the entries: a ruleset that came up short
      // for a reason we never classified is the failure mode no per-entry check
      // can see, and the server alerts on expected-vs-loaded divergence.
      await reportDnrSkipped(skipped, {
        loadedCount: applied,
        expectedCount: rules.length,
        failed: applied === 0,
        reason: "dnr-batch-rejected-salvaged",
      });
      return;
    }
    if (skipped.length) {
      console.warn(`DNR: skipped ${skipped.length} malformed policy entries:`, skipped);
      await reportDnrSkipped(skipped, {
        loadedCount: rules.length,
        expectedCount: rules.length + skipped.length,
        reason: "invalid-dnr-urlfilter",
      });
    }
    console.log(`🛡️ Updated ${rules.length} dynamic DNR block rules`);
  } catch (e) {
    // Reaching here means neither the batch nor the per-rule salvage completed,
    // so this device has NO dynamic enforcement at all. Previously this was a
    // console line on a Chromebook — i.e. invisible. Report it: a total load
    // failure is a customer-blocking outage and the server treats it as one.
    console.error("DNR update failed:", e);
    await reportDnrSkipped([], { failed: true, loadedCount: 0, reason: "dnr-update-threw" });
  }
}

// Surface malformed policy entries to the server so an admin can be told their
// rule is dead. A console warning on a Chromebook is not a signal anyone sees —
// that is precisely why Excel's broken entry survived in five policies.
async function reportDnrSkipped(skipped, meta = {}) {
  const entries = (skipped || []).filter(Boolean);
  // Report when there is anything to say: dropped entries OR a load failure OR
  // a count that came up short. An outage with no offending entry to name is
  // still an outage — requiring a non-empty `entries` array to report was why a
  // total failure stayed silent.
  const worthReporting = entries.length || meta.failed ||
    (typeof meta.expectedCount === "number" && meta.loadedCount < meta.expectedCount);
  if (!worthReporting || !config.orgId) return;
  try {
    await fetch(`${PROXY_BASE}/api/policy-entry-warnings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId: config.orgId,
        deviceId: config.deviceId,
        entries: entries.slice(0, 50),
        droppedCount: entries.length,
        reason: meta.reason || "invalid-dnr-urlfilter",
        ...(typeof meta.loadedCount === "number" ? { loadedCount: meta.loadedCount } : {}),
        ...(typeof meta.expectedCount === "number" ? { expectedCount: meta.expectedCount } : {}),
        ...(meta.failed ? { failed: true } : {}),
      }),
    });
  } catch (e) {
    // Never let telemetry failure affect enforcement.
  }
}

async function syncPulseConfig() {
  if (!config.enrolled || !config.orgId) return;
  try {
    const doc = await api.getPulseConfig(config.orgId);
    if (!doc || !doc.pulse) {
      // No remote config — fall back to built-in defaults
      pulseConfig.checks = null;
      pulseConfig.enabled = true;
      return;
    }
    // Extract pulse config from policy response
    const pulseData = doc.pulse;

    pulseConfig.enabled = pulseData.enabled !== false;

    if (Array.isArray(doc.categories) && doc.categories.length > 0) {
      // Remote format: [{ category, severity, terms: [...] }, ...]
      pulseConfig.checks = doc.categories.map(c => ({
        category: c.category || "unknown",
        severity: c.severity || "medium",
        terms: Array.isArray(c.terms) ? c.terms.map(t => t.toLowerCase()) : [],
      })).filter(c => c.terms.length > 0);

      if (pulseConfig.checks.length === 0) pulseConfig.checks = null;
    } else {
      pulseConfig.checks = null;
    }

    await chrome.storage.local.set({ pulseConfig });
    console.log("🧠 Pulse config synced:",
      pulseConfig.enabled ? "enabled" : "disabled",
      pulseConfig.checks ? `${pulseConfig.checks.length} remote categories` : "using defaults");
  } catch (e) {
    console.error("Pulse config sync failed, using current:", e);
    // On failure, try to restore from cache
    const cached = await chrome.storage.local.get("pulseConfig");
    if (cached.pulseConfig) {
      pulseConfig = cached.pulseConfig;
    }
  }
}

// ============================================================
// Heartbeat — richer device telemetry
// ============================================================

function startHeartbeat() {
  sendHeartbeat();
}

async function sendHeartbeat() {
  if (!config.enrolled) return;
  try {
    // Re-detect user on each heartbeat (handles account switches)
    await detectAndAssignUser();

    let incognitoAllowed = false;
    try { incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess(); } catch {}

    // Alert admin if incognito access is disabled (filtering gap!)
    if (!incognitoAllowed && config.orgId) {
      // Only alert once per session to avoid spam
      if (!deviceState._incognitoAlertSent) {
        deviceState._incognitoAlertSent = true;
        try {
          await api.post("/api/pulse-alert", {
            orgId: config.orgId,
            type: "security-misconfiguration",
            severity: "high",
            deviceId: config.deviceId,
            deviceName: config.deviceName,
            userEmail: config.userEmail,
            message: "Incognito mode access is disabled for KyberGate extension. Students can bypass filtering in Incognito windows. Enable 'Allow in Incognito' via Chrome management policy.",
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.warn("Failed to send incognito alert:", e);
        }
      }
    }

    // Get screen resolution from active tab
    let screenRes = "unknown";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id && !tab.url?.startsWith("chrome")) {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => `${screen.width}x${screen.height}`,
        });
        if (result?.result) screenRes = result.result;
      }
    } catch {}

    const ua = navigator.userAgent;
    const chromeVer = ua.match(/Chrome\/(\d+)/)?.[1] || "unknown";

    // Gather all open tabs for tab strip/management
    let openTabs = [];
    try {
      const allTabs = await chrome.tabs.query({});
      openTabs = allTabs.filter(t => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://")).map(t => ({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        favicon: t.favIconUrl || "",
        active: t.active || false,
        pinned: t.pinned || false,
        windowId: t.windowId,
      }));
    } catch {}

    await api.updateDevice(config.orgId, config.deviceId, {
      userEmail: config.userEmail || "",
      platform: `Chrome ${chromeVer}`,
      version: AGENT_VERSION,
      deviceName: config.deviceName || "",
      currentURL: deviceState.currentURL || "",
      currentTitle: deviceState.currentTitle || "",
      currentFavicon: deviceState.currentFavicon || "",
      tabs: openTabs,
      timestamp: new Date().toISOString(),
      sessionMode: classroomSession?.mode || "none",
      captureIntervalSeconds: classroomSession ? 10 : 30,
      lastForegroundUpdate: deviceState.lastTabUpdate ? new Date(deviceState.lastTabUpdate).toISOString() : "",
      screenshotFreshnessSeconds: deviceState.lastTabUpdate ? Math.floor((Date.now() - deviceState.lastTabUpdate) / 1000) : 999,
      lastCommandType: deviceState.lastCommandType || "",
      lastCommandAt: deviceState.lastCommandAt || "",
      lastSessionAckAt: deviceState.lastSessionAckAt || "",
      filterStats: {
        blockedToday: stats.blocked,
        allowedToday: stats.allowed,
      },
    });

    // Check lost mode status via proxy classroom session API
    try {
      const lostRes = await fetch(`${PROXY_BASE}/api/classroom/session?orgId=${encodeURIComponent(config.orgId)}&deviceId=${encodeURIComponent(config.deviceId)}&email=${encodeURIComponent(config.userEmail)}`);
      if (lostRes.ok) {
        const lostData = await lostRes.json();
        if (typeof lostData.lostMode === "boolean") {
          handleLostModeUpdate(lostData.lostMode);
        }
      }
    } catch (e) {
      // Non-critical — don't fail heartbeat over lost mode check
    }
  } catch (e) { console.error("Heartbeat failed:", e); }
}

// ============================================================
// Web Filtering
// ============================================================

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Strip a leading http:// or https:// from a policy entry.
//
// 🔴 2026-09-01, Excel Academy: a scheme-prefixed entry was a SILENTLY DEAD RULE
// on the EXTENSION path. matchesDomainEntry derives the host with
// e.split("/")[0], so "https://example.com/" produced entryHost === "https:",
// which matches no hostname on earth. Worse, a scheme-prefixed BARE HOST
// contains a "/", so it also took the path-entry branch — a host block that
// silently did nothing.
//
// The Go proxy grew exactly this guard on 2026-08-21 (proxy/domain_match.go
// stripScheme) after the same customer hit it there. The extension never got the
// port, and Excel is a Chromebook fleet — so their enforcement path kept the bug
// for another 11 days. Same policy row, two behaviours. AGAIN.
//
// Entries must be de-schemed BEFORE the "does it contain a slash" test, not after.
function stripScheme(entry) {
  return String(entry || "").replace(/^https?:\/\//, "");
}

// Host-only match for a single bare-domain entry.
function hostMatchesEntry(hostname, entry) {
  let e = stripScheme(String(entry || "").trim().toLowerCase());
  if (!e || e === "*") return false;
  // A bare host written with a trailing slash ("example.com/") is still a HOST
  // entry, not a path entry — admins type it constantly when pasting from the
  // address bar. Drop the empty path so it compares as the host it means.
  e = e.replace(/\/+$/, "");
  e = e.replace(/^\*\./, "").replace(/^www\./, "");
  if (!e) return false;
  const h = String(hostname || "").trim().toLowerCase().replace(/^www\./, "");
  return h === e || h.endsWith("." + e);
}

// Reduce a URL to "host/path", lowercased, scheme and leading www. removed.
function urlHostPath(rawUrl) {
  let u = String(rawUrl || "").trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "");
  return u.replace(/^www\./, "");
}

// 🔴 2026-08-18 — PATH ENTRY SUPPORT. This is a port of the proxy's
// matchesDomainEntry (proxy/domain_match.go). Keep the two in sync.
//
// The proxy learned path entries on 2026-08-06 for Excel Academy's Google Doodles
// request (google.com/logos/... blocked while google.com stays allowed). The
// extension never did — matchesDomain compared ONLY the hostname, so a path entry
// could not match anything, ever. Excel is 233/233 Chromebooks and Chromebooks
// enforce through THIS FILE, not the proxy, so the fix shipped on the one
// enforcement path that customer does not use. Same policy row, two behaviours.
function matchesDomainEntry(hostname, rawUrl, entry) {
  // De-scheme FIRST: "https://example.com" contains a "/" and would otherwise be
  // misrouted into the path branch and never match. See stripScheme.
  const e0 = stripScheme(String(entry || "").trim().toLowerCase());
  if (!e0 || e0 === "*") return false;
  // "example.com/" is a host entry with an empty path, not a path entry.
  if (!e0.replace(/\/+$/, "").includes("/")) return hostMatchesEntry(hostname, e0);

  // Path entry. Trim a trailing "/*" or "*" so the wildcard is not compared
  // literally, then require the request's host+path to start with it.
  let e = e0.replace(/\*+$/, "").replace(/\/$/, "");
  e = e.replace(/^\*\./, "").replace(/^www\./, "");

  const entryHost = e.split("/")[0];
  if (!hostMatchesEntry(hostname, entryHost)) return false;
  // No URL available (host-only caller): the host matched an entry scoped to a
  // path. Deliberately broader than the entry, so callers that cannot see a path
  // must use this ONLY to decide whether a domain is "known", never to block.
  if (!rawUrl) return true;
  return urlHostPath(rawUrl).startsWith(e);
}

// hostname-only wrapper, preserved for callers with no URL in hand.
function matchesDomain(hostname, domainList) {
  for (const d of (domainList || [])) {
    if (matchesDomainEntry(hostname, "", d)) return true;
  }
  return false;
}

// URL-aware match. Use this on the enforcement path so path entries work.
function matchesDomainUrl(hostname, rawUrl, domainList) {
  for (const d of (domainList || [])) {
    if (matchesDomainEntry(hostname, rawUrl, d)) return true;
  }
  return false;
}

// SPECIFICITY precedence between a broad allow and a narrow block.
//
// The allowlist is evaluated before the blocklist, so a bare-host allow returns
// first and a path-scoped block is never consulted — which is exactly how
// `google.com` allowed + `google.com/logos` blocked resolved to "allowed" and made
// the Doodles block a silent no-op. An allow with NO path is a host-wide
// statement; a block WITH a path is narrower and more deliberate, so the narrower
// entry wins. Mirrors pathBlockBeatsHostAllow in proxy/domain_match.go.
//
// Conservative on purpose: only a bare-host allow can be overridden, and a URL is
// required. Without a path we cannot tell /logos from /search and must never
// broaden a path block into a host block — that would take down all of google.com.
function pathBlockBeatsHostAllow(hostname, rawUrl, allowEntry, blockedEntries) {
  if (!rawUrl) return false;
  if (String(allowEntry || "").trim().toLowerCase().includes("/")) return false;
  for (const b of (blockedEntries || [])) {
    if (!String(b || "").includes("/")) continue;
    if (matchesDomainEntry(hostname, rawUrl, b)) return true;
  }
  return false;
}

// Which allow entry matched, or null. Needed because specificity precedence has to
// inspect the matching allow entry, not just know that one existed.
function matchingAllowEntry(hostname, rawUrl, domainList) {
  for (const d of (domainList || [])) {
    if (matchesDomainEntry(hostname, rawUrl, d)) return d;
  }
  return null;
}

// O(depth) Set lookup: check hostname and each parent domain against the Set
function matchesDomainInSet(hostname, domainSet) {
  if (domainSet.has(hostname)) return true;
  let dot = hostname.indexOf('.');
  while (dot !== -1) {
    const parent = hostname.substring(dot + 1);
    if (domainSet.has(parent)) return true;
    dot = hostname.indexOf('.', dot + 1);
  }
  return false;
}

// Should this verdict be written to the activity log?
//
// A `policyPending` verdict is not a decision — it is the absence of one. Logging
// it as `allowed` is what put a phantom "allowed" row next to the real "blocked"
// row in Excel Academy's dashboard and made a working block look like a bypass.
// Blocks are always logged; genuine allows are always logged (the audit trail is
// a compliance requirement). Only the pending window is suppressed.
function shouldLogVerdict(verdict) {
  if (!verdict) return false;
  if (verdict.policyPending) return false;
  return true;
}

function checkUrl(url) {
  if (!config.enrolled) return { allowed: true };
  const hostname = getDomain(url);
  if (!hostname) return { allowed: true };

  // Policy not loaded yet (MV3 respawn window). Do NOT report a clean allow:
  // the blocklist is still empty, so "allowed" here means "unknown", and the
  // caller must not log it as a decision. See the policyReady comment above.
  //
  // The check is `!policyLoaded()` rather than `!policyReady` so that a policy
  // present in memory counts as loaded even if the flag was never set. Anything
  // holding real rules IS a policy; deriving from the data instead of trusting a
  // separate boolean removes the class of bug where the two drift apart.
  if (!policyLoaded()) {
    return { allowed: true, policyPending: true, domain: hostname };
  }

  // Allowlist first — but a bare-host allow does NOT beat a path-scoped block.
  // See pathBlockBeatsHostAllow: `google.com` allowed + `google.com/logos` blocked
  // must resolve to BLOCKED for /logos and allowed everywhere else.
  const allowHit = matchingAllowEntry(hostname, url, policy.allowedDomains);
  if (allowHit && !pathBlockBeatsHostAllow(hostname, url, allowHit, policy.blockedDomains)) {
    return { allowed: true };
  }

  // Ad/tracker blocking — silent block (no block page)
  if (policy.blockAds !== false) {
    if (matchesDomainInSet(hostname, AD_TRACKER_DOMAINS)) {
      return { allowed: false, category: "ad-blocked", domain: hostname, silent: true };
    }
  }

  // Blocked domains (explicit from policy) — URL-aware so path entries enforce.
  if (matchesDomainUrl(hostname, url, policy.blockedDomains)) return { allowed: false, category: "Blocked Domain", domain: hostname };

  // Category-based blocking — check ALL blocked categories against domain sets
  for (const cat of policy.blockedCategories) {
    const domainSet = CATEGORY_DOMAINS[cat];
    if (domainSet && matchesDomainInSet(hostname, domainSet)) {
      // Format category name for display
      const displayCat = cat.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
      return { allowed: false, category: displayCat, domain: hostname };
    }
  }

  // Gaming always on by default
  if (policy.blockGames && !policy.blockedCategories.includes("gaming")) {
    if (matchesDomainInSet(hostname, GAMING_DOMAINS)) {
      return { allowed: false, category: "Gaming", domain: hostname };
    }
  }

  // Game keyword in URL
  if (policy.blockGames) {
    const lowerUrl = url.toLowerCase();
    for (const kw of GAME_KEYWORDS) {
      if (lowerUrl.includes(kw.replace(/ /g, "+")) || lowerUrl.includes(kw.replace(/ /g, "%20"))) {
        return { allowed: false, category: "Gaming", domain: hostname };
      }
    }
  }

  // Gambling keyword in URL/domain
  if (policy.blockedCategories.includes("gambling")) {
    const lowerUrl = url.toLowerCase();
    const lowerHost = hostname.toLowerCase();
    for (const kw of GAMBLING_KEYWORDS) {
      if (lowerHost.includes(kw) || lowerUrl.includes("/" + kw) || lowerUrl.includes(kw + "-")) {
        return { allowed: false, category: "Gambling", domain: hostname };
      }
    }
  }

  // Keyword matching in URL
  const lowerUrl = url.toLowerCase();
  for (const kw of policy.blockedKeywords) {
    if (kw && lowerUrl.includes(kw.toLowerCase())) {
      return { allowed: false, category: "Blocked Keyword", domain: hostname };
    }
  }

  return { allowed: true, domain: hostname };
}

// ============================================================
// Dynamic URL Categorization (for unknown domains)
// ============================================================

const checkedDomains = new Map(); // domain -> { category, timestamp }

async function checkDomainDynamic(hostname, url) {
  // Skip if already checked recently (cache 30 min)
  const cached = checkedDomains.get(hostname);
  if (cached && Date.now() - cached.timestamp < 1800000) {
    return cached.category;
  }

  try {
    const params = new URLSearchParams({ domain: hostname, url: url || "" });
    const res = await fetch(`${PROXY_BASE}/api/categorize?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const cat = data.category || null;
    checkedDomains.set(hostname, { category: cat, blocked: data.blocked, timestamp: Date.now() });

    // Trim cache to 500 entries
    if (checkedDomains.size > 500) {
      const oldest = checkedDomains.keys().next().value;
      checkedDomains.delete(oldest);
    }
    return cat;
  } catch { return null; }
}

// ============================================================
// KyberPulse — Student Safety Search Monitoring
// ============================================================

// Default built-in terms (fallback when no remote config exists)
const DEFAULT_PULSE_SELF_HARM = [
  "how to kill myself", "i want to die", "suicide methods", "how to commit suicide",
  "painless ways to die", "i want to end it all", "best way to kill yourself",
  "how to hang yourself", "overdose on pills", "cutting myself",
  "self harm methods", "i hate my life", "nobody would miss me",
  "world would be better without me", "suicide hotline", "suicidal thoughts",
  "ways to end my life", "i can't take it anymore", "i want to disappear",
  "planning suicide", "goodbye letter", "suicide note",
  "how many pills to overdose", "jump off a building", "slit wrists",
];

const DEFAULT_PULSE_VIOLENCE = [
  "how to make a bomb", "school shooting", "shoot up the school",
  "how to make a weapon", "how to get a gun", "hit list",
  "bomb threat", "kill everyone", "massacre", "bring a gun to school",
  "school attack plan", "columbine", "how to make explosives",
  "how to make a knife", "how to stab someone", "mass shooting",
  "pipe bomb", "pressure cooker bomb", "how to build a gun",
  "how to poison someone", "ricin", "anthrax",
];

const DEFAULT_PULSE_CYBERBULLY = [
  "kill yourself", "kys", "go die", "you should die",
  "nobody likes you", "you're worthless", "everyone hates you",
  "go kill yourself", "drink bleach", "neck yourself",
  "you're ugly", "fat ugly", "you're disgusting",
  "i'll beat you up", "i know where you live", "i'll find you",
];

const DEFAULT_PULSE_SUBSTANCE = [
  "how to buy drugs", "where to buy weed", "how to get high",
  "buy xanax online", "buy adderall", "fake id to buy alcohol",
  "how to make lean", "buy vape underage", "buy juul pods",
];

const DEFAULT_PULSE_CHECKS = [
  { terms: DEFAULT_PULSE_SELF_HARM, category: "self-harm", severity: "critical" },
  { terms: DEFAULT_PULSE_VIOLENCE, category: "violence", severity: "critical" },
  { terms: DEFAULT_PULSE_CYBERBULLY, category: "cyberbullying", severity: "high" },
  { terms: DEFAULT_PULSE_SUBSTANCE, category: "substance-abuse", severity: "medium" },
];

function getActivePulseChecks() {
  // Remote config from proxy API takes priority over built-in defaults
  return pulseConfig.checks || DEFAULT_PULSE_CHECKS;
}

function checkPulseSearch(query) {
  if (!query || !pulseConfig.enabled) return null;
  const q = query.toLowerCase();
  for (const check of getActivePulseChecks()) {
    const matched = check.terms.filter(term => q.includes(term));
    if (matched.length > 0) {
      return { category: check.category, severity: check.severity, matchedTerms: matched };
    }
  }
  return null;
}

async function writePulseAlert(searchQuery, searchEngine, url, pulseResult) {
  if (!config.enrolled || !config.orgId) return;
  try {
    await api.writePulseAlert(config.orgId, {
      type: "search",
      source: "chrome-extension",
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      userEmail: config.userEmail || "",
      domain: getDomain(url) || searchEngine || "",
      url: url || "",
      searchQuery: searchQuery,
      searchEngine: searchEngine || "",
      category: pulseResult.category,
      severity: pulseResult.severity,
      matchedTerms: pulseResult.matchedTerms,
      action: "flagged",
      status: "new",
      timestamp: new Date().toISOString(),
    });
    console.log(`🚨 PULSE ALERT [${pulseResult.severity}/${pulseResult.category}]: "${searchQuery}" — matched: ${pulseResult.matchedTerms.join(", ")}`);
  } catch (e) {
    console.error("Pulse alert write failed:", e);
  }
}

// ============================================================
// Search Query Extraction & Logging
// ============================================================

function extractSearchQuery(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    // Google
    if (host.includes("google.") && u.pathname === "/search") return { engine: "Google", query: u.searchParams.get("q") };
    // Bing
    if (host.includes("bing.com") && u.pathname === "/search") return { engine: "Bing", query: u.searchParams.get("q") };
    // YouTube
    if (host.includes("youtube.com") && u.pathname === "/results") return { engine: "YouTube", query: u.searchParams.get("search_query") };
    // DuckDuckGo
    if (host.includes("duckduckgo.com") && u.searchParams.has("q")) return { engine: "DuckDuckGo", query: u.searchParams.get("q") };
    // Yahoo
    if (host.includes("search.yahoo.com")) return { engine: "Yahoo", query: u.searchParams.get("p") };
  } catch {}
  return null;
}

// ============================================================
// SafeSearch Enforcement (enhanced with YouTube Restricted Mode)
// ============================================================

function enforceSafeSearch(url) {
  if (!policy.safeSearch) return null;
  try {
    const u = new URL(url);
    const host = u.hostname;

    // Google
    if (host.includes("google.") && u.pathname === "/search") {
      if (u.searchParams.get("safe") !== "active") {
        u.searchParams.set("safe", "active");
        return u.toString();
      }
    }

    // Google Images
    if (host.includes("google.") && u.pathname === "/images") {
      if (u.searchParams.get("safe") !== "active") {
        u.searchParams.set("safe", "active");
        return u.toString();
      }
    }

    // Bing
    if (host.includes("bing.com") && (u.pathname === "/search" || u.pathname === "/images/search")) {
      if (u.searchParams.get("adlt") !== "strict") {
        u.searchParams.set("adlt", "strict");
        return u.toString();
      }
    }

    // YouTube — Restricted Mode is enforced by the YouTube-Restrict REQUEST HEADER
    // (see ensureYouTubeRestrictHeaderRule), NOT by a URL rewrite.
    //
    // ⚠️ DO NOT rewrite the hostname to restrict.youtube.com.
    // That name is a DNS CNAME TARGET, not a browsable web host: it serves no
    // public certificate and no site, so navigating a browser to it yields a 404.
    // Reported by St. Michael's 2026-08-06 ("YouTube is being directed to
    // restrict.youtube.com, which is a 404") — YouTube was effectively unusable
    // for every device running the extension with safeSearch on.
    //
    // The DNS server (dns-server/main.go safeSearchMap) uses the SAME hostname
    // CORRECTLY, because there it is the right-hand side of a CNAME and the
    // browser never sees it. Same string, two mechanisms — only one is valid here.
    if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
      return null; // header rule handles it; no navigation change needed
    }

    // DuckDuckGo
    if (host.includes("duckduckgo.com")) {
      if (u.searchParams.get("kp") !== "1") {
        u.searchParams.set("kp", "1");
        return u.toString();
      }
    }

    // Yahoo
    if (host.includes("search.yahoo.com")) {
      if (u.searchParams.get("vm") !== "r") {
        u.searchParams.set("vm", "r");
        return u.toString();
      }
    }
  } catch {}
  return null;
}

// ============================================================
// AI Overview Disable (Google udm=14)
// ============================================================

// KNOWN_CONTENT_TAB_UDMS — the `udm` values that are ordinary, non-AI Google
// search tabs: All=(none) Images=2 Videos=7 News=12 Shopping=28 Web=14.
//
// 🔴 2026-09-03, Excel Academy report #3 — THIS IS AN ALLOWLIST ON PURPOSE.
//
// "also Google AI mode is active when it's switched off"
//
// "AI Overview" and "AI Mode" are two DIFFERENT Google features (Google's own
// docs list them separately), and AI Mode is routed through this SAME udm
// parameter. The check below used to bail on ANY udm, so an AI Mode URL looked
// exactly like a tab click and this function returned without doing anything —
// the "Disable AI Overview" policy toggle read ON in the console while
// enforcing nothing on the AI surface it is named after.
//
// An allowlist rather than a `udm === "<ai mode value>"` special case, because
// Google's udm numbering is undocumented and has changed before. With a
// denylist, the next value Google ships silently reopens the hole and we hear
// about it from a customer. Here an UNRECOGNISED udm is forced to web-only:
// unknown is SAFE, not permissive.
//
// ⚠️ SECOND COPY. proxy/safesearch.go carries knownContentTabUDMs with the same
// values, and chrome-extension/test/ai-mode-toggle.test.js pins the two lists
// together. Chromebook fleets enforce HERE, not in the proxy, so changing one
// without the other means iPads and Chromebooks filter Google differently —
// the exact drift proxy/main.go warns about for focusModeDriveDomains.
const KNOWN_CONTENT_TAB_UDMS = new Set(["2", "7", "12", "28", "14"]);

function enforceDisableAIOverview(url) {
  if (!policy.disableAIOverview) return null;
  try {
    const u = new URL(url);
    const host = u.hostname;
    // Only apply to Google search domains
    if (!host.includes("google.")) return null;
    // Only apply to search paths
    const path = u.pathname.toLowerCase();
    if (path !== "/search" && path !== "/webhp" && path !== "/" && !path.startsWith("/search")) return null;
    // ⚠️ DO NOT overwrite a udm/tbm the user chose (fixed 2026-08-17).
    // Google encodes the search TABS in the same `udm` param used for
    // "Web only": All=(none) Images=2 Videos=7 News=12 Shopping=28 Web=14.
    // Forcing udm=14 whenever udm != 14 rewrote every Images/Videos/News/
    // Shopping click back to the Web tab. Worse here than in the proxy: this
    // path calls chrome.tabs.update(), so the tab visibly snapped back.
    // Reported by Excel Academy: "Students can't click on any of these
    // after a google search."
    // AI Overview only renders on the All tab, so preserving an explicit tab
    // choice costs no filtering coverage.
    //
    // `tbm` is the legacy tab param and has no AI vertical, so any tbm is a
    // genuine tab choice. A `udm` is only honoured when we RECOGNISE it as a
    // content tab — see KNOWN_CONTENT_TAB_UDMS above for why anything else
    // (including AI Mode) must fall through to web-only.
    if (u.searchParams.get("tbm")) return null;
    const udm = u.searchParams.get("udm");
    if (udm && KNOWN_CONTENT_TAB_UDMS.has(udm)) return null;

    u.searchParams.set("udm", "14");
    return u.toString();
  } catch {}
  return null;
}

// ============================================================
// School Hours Check
// ============================================================
//
// 🔴 2026-09-05, issue #449 — DEVICE-CLOCK FILTERING BYPASS (SECURITY).
//
// This function used to answer "are we inside school hours?" from `new Date()`
// — the DEVICE clock — converted through `policy.timezone` with a hardcoded
// "America/New_York" fallback. Reproduced before the fix: with an 08:00–15:00
// Mon–Fri schedule, moving ONLY the Chromebook clock from 10:00 to 22:00 flipped
// this from true to false. Time-scheduled filtering stopped applying, and
// nothing on the device or in the logs could tell that from a real evening.
//
// THE DEVICE IS THE ATTACKER. Its clock is attacker-controlled input and must
// never decide a filtering verdict. The verdict is now computed SERVER-side
// (proxy/extension_schedule.go, resolveExtensionSchedule) and delivered as a
// resolved boolean with a short TTL. This function CONSUMES that verdict. It
// does not, and must never again, evaluate a window against local time.
//
// ⚠️ EVERY UNCERTAIN PATH RETURNS TRUE (= filter). The pre-existing `return true`
// fail-safes are deliberate and are preserved verbatim below. Do not "clean
// them up": each one is a case where we cannot prove the device is outside
// school hours, and the safe answer to that is to keep filtering.
//
// The three ways this can be uncertain, and what each does:
//   1. NO VERDICT YET (first sync not landed, or an old server that does not
//      send one)          → FILTER.
//   2. VERDICT EXPIRED (older than its TTL — device offline, sync wedged, or
//      the worker was evicted for longer than the TTL)   → FILTER.
//   3. CLOCK SKEW beyond tolerance vs the server's time → FILTER, and report.
//      A device whose clock disagrees with the server is either broken or being
//      tampered with. Both mean filter.
//
// Case 2 is worth stating plainly because it is the one that looks like a
// regression in the field: a device that cannot reach the server keeps
// filtering on its last-known rules, and once the schedule verdict lapses it
// filters unconditionally rather than assuming the school day ended. OFFLINE
// AND TTL EXPIRY BOTH DEFAULT TO FILTERING. That is the intended behaviour.

/**
 * How long a server schedule verdict may be reused, in ms.
 *
 * 5 minutes, matching extensionScheduleTTLSeconds on the server and sitting
 * exactly on the hard ceiling #453 sets for push-based policy propagation
 * (1–5 minutes across all platforms). The TTL must not outlive that ceiling or
 * a device could keep enforcing a schedule state the server already replaced.
 * The policySync alarm runs every 60s and a WebSocket pushes changes instantly,
 * so a healthy device refreshes ~5x per TTL; 300s is the outer bound for a
 * device that has lost both channels, and when it lapses the device filters.
 */
const SCHEDULE_VERDICT_TTL_MS = 300 * 1000;

/**
 * Maximum tolerated disagreement between device and server clock, in ms.
 *
 * 2 minutes. Unsynchronised consumer hardware drifts tens of seconds, and
 * request latency plus MV3 service-worker wake delay adds more, so a tighter
 * threshold would flag healthy devices constantly. Meanwhile a student escaping
 * an 08:00–15:00 window has to move the clock by HOURS for it to matter. The
 * band between normal drift and meaningful tampering is very wide; 2 minutes
 * sits in it. Keep in sync with extensionClockSkewToleranceMs (Go).
 */
const CLOCK_SKEW_TOLERANCE_MS = 120 * 1000;

/**
 * Last schedule verdict received from the server.
 *
 * `receivedAtMs` is stamped from the DEVICE clock, which is the one thing we
 * cannot trust — but it is only ever used to EXPIRE the verdict, and expiry
 * fails toward filtering. Winding the clock forward expires the verdict sooner
 * (→ filter). Winding it backward makes the verdict look fresher, which is
 * precisely why clock skew is checked independently and also fails to filter.
 * There is no direction a student can move the clock that turns filtering off.
 */
let scheduleVerdict = null;

/** Most recent measured device-vs-server clock skew, for heartbeat reporting. */
let lastClockSkewMs = 0;

/**
 * Record the server's resolved schedule verdict from a policy sync.
 *
 * Also measures device clock skew against the server's `serverTimeMs`. A
 * malformed or absent verdict clears the cache, which makes
 * isDuringSchoolHours() fall into its "no verdict" branch — i.e. filter.
 */
function setScheduleVerdict(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.inForce !== "boolean") {
    scheduleVerdict = null;
    return null;
  }

  const deviceNowMs = Date.now();
  let skewMs = 0;
  if (Number.isFinite(raw.serverTimeMs) && raw.serverTimeMs > 0) {
    skewMs = deviceNowMs - raw.serverTimeMs;
  }
  lastClockSkewMs = skewMs;

  // A server-supplied TTL is honoured only when it is sane AND not longer than
  // our own ceiling — a compromised or misconfigured value must not be able to
  // extend how long a device coasts on a stale verdict.
  let ttlMs = SCHEDULE_VERDICT_TTL_MS;
  if (Number.isFinite(raw.ttlSeconds) && raw.ttlSeconds > 0) {
    ttlMs = Math.min(raw.ttlSeconds * 1000, SCHEDULE_VERDICT_TTL_MS);
  }

  scheduleVerdict = {
    inForce: raw.inForce,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    serverTimeMs: raw.serverTimeMs,
    receivedAtMs: deviceNowMs,
    ttlMs,
    skewMs,
  };

  if (Math.abs(skewMs) > CLOCK_SKEW_TOLERANCE_MS) {
    // Report it — a skewed clock is a tamper signal worth seeing in the fleet,
    // and it is the only way an admin learns the device is lying about time.
    // Aggregate signal only: how far off, never who or what they browsed.
    console.warn(
      `⏰ Device clock skew ${Math.round(skewMs / 1000)}s vs server ` +
        `(tolerance ${CLOCK_SKEW_TOLERANCE_MS / 1000}s) — filtering enforced`,
    );
    reportClockSkew(skewMs);
  }

  return scheduleVerdict;
}

/**
 * Report meaningful clock skew to the server, best-effort.
 *
 * Deliberately fire-and-forget: this is telemetry, and a failure to report must
 * never change the filtering decision. The decision has already been made to
 * filter by the time we get here.
 */
function reportClockSkew(skewMs) {
  try {
    if (!config.enrolled || !config.orgId) return;
    fetch(`${PROXY_BASE}/api/clock-skew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId: config.orgId,
        deviceId: config.deviceId,
        skewMs: Math.round(skewMs),
        toleranceMs: CLOCK_SKEW_TOLERANCE_MS,
        agentVersion: AGENT_VERSION,
      }),
    }).catch(() => {});
  } catch (e) {
    // Never let telemetry break enforcement.
  }
}

/**
 * Is time-scheduled filtering in force right now?
 *
 * Returns the SERVER's verdict, or true (filter) when that verdict is missing,
 * stale, or accompanied by a device clock we cannot trust. Never computes a
 * time window locally — see the block comment above.
 */
function isDuringSchoolHours() {
  try {
    const v = scheduleVerdict;

    // 1. No server verdict yet → filter.
    if (!v) return true; // Default to always filtering

    // 2. Verdict older than its TTL → filter. Covers offline devices, a wedged
    //    sync, and a service worker that slept past the TTL.
    const ageMs = Date.now() - v.receivedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > v.ttlMs) {
      return true; // Default to always filtering
    }

    // 3. Device clock disagrees with the server beyond tolerance → filter.
    //    Broken or tampered, both mean filter.
    if (Math.abs(v.skewMs) > CLOCK_SKEW_TOLERANCE_MS) {
      return true; // Default to always filtering
    }

    return v.inForce;
  } catch (e) {
    console.error("School hours check failed:", e);
  }
  return true; // Default to always filtering
}

// ============================================================
// Alarms
// ============================================================

chrome.alarms.create("policySync", { periodInMinutes: 1 });
chrome.alarms.create("heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.create("flushLogs", { periodInMinutes: 0.25 });
chrome.alarms.create("activeTabTruth", { periodInMinutes: 0.1667 });
chrome.alarms.create("screenshotBackup", { periodInMinutes: 1 }); // Safety net for screenshot capture

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "policySync") { await syncPolicies(); connectPolicyWebSocket(); }
  if (alarm.name === "heartbeat") {
    // Reap BEFORE the heartbeat so the telemetry it sends reports the mode the
    // device is actually enforcing, not an expired one. Alarms survive MV3
    // eviction; the 10s classroom setInterval does not (#551).
    await reapExpiredClassroomLease();
    await sendHeartbeat();
  }
  if (alarm.name === "flushLogs") await flushLogs();
  if (alarm.name === "activeTabTruth") await pollActiveTabTruth();
  if (alarm.name === "screenshotBackup") {
    // Safety net: if setInterval died (service worker restart), restart capture
    if (config.enrolled && !screenshotInterval && !screenViewInterval) {
      console.log("📸 screenshotBackup alarm: capture stopped, restarting");
      startScreenViewMonitoring();
    }
  }
});

// ============================================================
// Navigation Listener (main filtering entry point)
// ============================================================

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // Main frame only
  if (!config.enrolled) return;

  const url = details.url;
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:") || url.startsWith("edge://")) return;

  // ── Data URI Bypass Detection ──
  // Kids paste data:text/html;base64,... into the address bar from shared Google Docs.
  // The base64 decodes to a full HTML page (game hub, proxy, etc.) that runs locally
  // with no network request — invisible to proxy/DNS filters. Block it here.
  if (url.startsWith("data:")) {
    // Block data:text/html (the dangerous one — full page rendering)
    // Allow harmless data URIs like data:image/* which sites use legitimately
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.startsWith("data:text/html") || lowerUrl.startsWith("data:application/xhtml")) {
      stats.blocked++;
      await chrome.storage.local.set({ blocked: stats.blocked });

      const bCategory = "Filter Bypass: Data URI";
      const bOrgId = config.orgId || "";
      const blockUrl = chrome.runtime.getURL("blocked.html") + "?domain=" + encodeURIComponent("data: URI") + "&category=" + encodeURIComponent(bCategory) + "&orgId=" + encodeURIComponent(bOrgId);
      chrome.tabs.update(details.tabId, { url: blockUrl });

      logRequest("data-uri", "blocked", bCategory, url.slice(0, 200)); // truncate — data URIs can be huge
      console.log("🚫 Blocked data:text/html URI bypass attempt");
      return;
    }
  }

  // SafeSearch redirect
  const safeUrl = enforceSafeSearch(url);
  if (safeUrl && safeUrl !== url) {
    chrome.tabs.update(details.tabId, { url: safeUrl });
    return;
  }

  // AI Overview disable (Google udm=14)
  const noAIUrl = enforceDisableAIOverview(url);
  if (noAIUrl && noAIUrl !== url) {
    chrome.tabs.update(details.tabId, { url: noAIUrl });
    return;
  }

  // Extract and log search queries
  const search = extractSearchQuery(url);
  if (search && search.query) {
    logRequest(getDomain(url), "allowed", "Search", url, search.query, search.engine);

    // KyberPulse: check search query for safety concerns
    const pulseResult = checkPulseSearch(search.query);
    if (pulseResult) {
      writePulseAlert(search.query, search.engine, url, pulseResult);
    }
  }

  // Check filtering (hardcoded + policy categories)
  // First check classroom session restrictions
  const classroomData = await chrome.storage.local.get(CLASSROOM_STATE_KEYS);
  // 🔴 LEASE GATE (#551). The stored mode enforces only while its lease is
  // valid. An expired or missing lease reads as "none", so this whole classroom
  // block is skipped and the request falls through to the normal org-policy
  // engine below — server truth, NOT unfiltered. That fall-through is the
  // fail-safe property; see effectiveClassroomMode(). Without this gate a
  // stale enforcing value survives forever (Excel Academy, 11 devices, 3d 20h).
  const clMode = effectiveClassroomMode(classroomData);

  if (clMode === "locked" || clMode === "lockdown") {
    // Block everything during lockdown
    const bOrgId = config.orgId || "";
    const blockUrl = chrome.runtime.getURL("blocked.html") + "?domain=locked&category=" + encodeURIComponent("🔒 Device Locked by Teacher") + "&orgId=" + encodeURIComponent(bOrgId);
    chrome.tabs.update(details.tabId, { url: blockUrl });
    stats.blocked++;
    await chrome.storage.local.set({ blocked: stats.blocked });
    logRequest(getDomain(url), "blocked", "Classroom: Locked", url);
    return;
  }

  if (clMode === "focus" || clMode === "assessment") {
    const allowedDomains = classroomData.classroomAllowedDomains || [];
    const hostname = getDomain(url);
    // 🔴 2026-09-03, #346/#347 — FOCUS MODE MUST UNION, NOT REPLACE.
    //
    // This branch used to consult ONLY classroomAllowedDomains. An active focus
    // session therefore REPLACED the school's own allowlist: every instructional
    // tool the org allowlisted went dark for the duration. Excel Academy's grades
    // 3-5 lost drive.google.com — allowlisted, visible as allowed in the console,
    // and blocked anyway — plus their reading and math tools and kybergate.com
    // itself. 254 blocks across 32 devices in 24h.
    //
    // A teacher's focus list NARROWS attention; it is not consent to un-allowlist
    // the school's curriculum. The teacher never saw the org allowlist and cannot
    // be asked to re-type it. A school-approved tool going dark mid-lesson is a
    // worse failure than a slightly wider focus set, so the two lists UNION.
    // Teacher BLOCKS (restrict mode) are unaffected — this only widens allows.
    //
    // Use the SHARED matcher, not a raw ===/endsWith compare. The inline compare
    // made "*." and scheme-prefixed entries DEAD RULES here while working
    // everywhere else in the product — the third time that exact divergence has
    // bitten this customer (see stripScheme and matchesDomainEntry above).
    const essentialDomains = [
      "accounts.google.com", "oauth.google.com", "login.microsoftonline.com",
      "login.live.com", "auth.clever.com", "clever.com", "sso.canvaslms.com",
      "fonts.googleapis.com", "fonts.gstatic.com", "ssl.gstatic.com",
      "apis.google.com", "www.googleapis.com",
      "proxy.kybergate.com", "clients1.google.com", "clients2.google.com",
      "clients3.google.com", "clients4.google.com", "lh3.googleusercontent.com",
      "drive.google.com", "docs.google.com", "drive.usercontent.google.com",
      "googleusercontent.com", "clients6.google.com",
    ];
    // Drive additions above, and why each is needed:
    //   drive.google.com / docs.google.com  — Drive is not one host; opening a
    //     Doc, Sheet or Slide from Drive leaves the Drive origin entirely.
    //   drive.usercontent.google.com        — file downloads and previews.
    //   googleusercontent.com               — thumbnails. Only lh3 was listed,
    //     so lh5/lh6 broke. The matcher tests hostname.endsWith("." + d), so
    //     this apex entry subsumes the whole lh* range. lh3 above is now
    //     redundant, kept deliberately: dropping it is a behaviour change this
    //     PR does not need. NOTE this widens to ALL googleusercontent.com
    //     subdomains, which is user-generated-content hosting — acceptable here
    //     because it applies ONLY inside a focus session, where the alternative
    //     is a blank Drive, and normal org filtering still governs outside one.
    //   clients6.google.com                 — Drive RPC; clients1-4 were listed.
    const isEssential = essentialDomains.some(d => hostname === d || hostname.endsWith("." + d));
    // Org policy allowlist is part of the focus allow set. matchesDomainUrl is
    // the same URL-aware path the normal engine uses, so path entries and "*."
    // wildcards behave identically inside and outside a session.
    const isPolicyAllowed = matchesDomainUrl(hostname, url, policy.allowedDomains);
    const isSessionAllowed = matchesDomainUrl(hostname, url, allowedDomains);
    const isAllowed = isEssential || isPolicyAllowed || isSessionAllowed;
    if (!isAllowed && hostname) {
      const bOrgId = config.orgId || "";
      const blockUrl = chrome.runtime.getURL("blocked.html") + "?domain=" + encodeURIComponent(hostname) + "&category=" + encodeURIComponent("📚 Focus Mode — Only approved sites allowed") + "&orgId=" + encodeURIComponent(bOrgId);
      chrome.tabs.update(details.tabId, { url: blockUrl });
      stats.blocked++;
      await chrome.storage.local.set({ blocked: stats.blocked });
      logRequest(hostname, "blocked", "Classroom: Focus Mode", url);
      return;
    }
  }

  if (clMode === "restrict") {
    const blockedDomains = classroomData.classroomBlockedDomains || [];
    const hostname = getDomain(url);
    const isTeacherBlocked = blockedDomains.some(d => hostname === d || hostname.endsWith("." + d));
    if (isTeacherBlocked && hostname) {
      const bOrgId = config.orgId || "";
      const blockUrl = chrome.runtime.getURL("blocked.html") + "?domain=" + encodeURIComponent(hostname) + "&category=" + encodeURIComponent("\ud83d\udeab Your teacher has blocked this site during class") + "&orgId=" + encodeURIComponent(bOrgId);
      chrome.tabs.update(details.tabId, { url: blockUrl });
      stats.blocked++;
      await chrome.storage.local.set({ blocked: stats.blocked });
      logRequest(hostname, "blocked", "Classroom: Restrict Mode", url);
      return;
    }
  }

  // Normal filtering
  const result = checkUrl(url);

  if (!result.allowed) {
    stats.blocked++;
    await chrome.storage.local.set({ blocked: stats.blocked });

    // Silent block for ads/trackers — cancel without showing block page
    if (result.silent) {
      logRequest(result.domain, "blocked", "ad-blocked", url);
      return;
    }

    const bDomain = result.domain || getDomain(url) || "unknown";
    const bCategory = result.category || "Blocked";
    const bOrgId = config.orgId || "";
    const blockUrl = chrome.runtime.getURL("blocked.html") + "?domain=" + encodeURIComponent(bDomain) + "&category=" + encodeURIComponent(bCategory) + "&orgId=" + encodeURIComponent(bOrgId);
    chrome.tabs.update(details.tabId, { url: blockUrl });

    logRequest(result.domain, "blocked", result.category, url);
  } else {
    stats.allowed++;
    await chrome.storage.local.set({ allowed: stats.allowed });

    // Log page navigations — but never during the policy-pending window, where
    // "allowed" only means "policy had not loaded yet" (2026-09-01, Excel).
    if (result.domain && shouldLogVerdict(result)) {
      logRequest(result.domain, "allowed", "", url);
    }

    // Async: check unknown domains via AI categorization
    const hostname = getDomain(url);
    if (hostname && !isKnownDomain(hostname)) {
      checkDomainDynamic(hostname, url).then(cat => {
        // #426: the decision to ignore a verdict comes from CLASSIFIER_SAFE_CATEGORIES,
        // never from a literal list here. "shopping" used to be hard-coded into this
        // condition while also being a category admins could block, so those verdicts
        // were silently discarded.
        if (!shouldIgnoreClassifierCategory(cat)) {
          // Check if this category is in the blocked list
          if (policy.blockedCategories.includes(cat)) {
            const displayCat = cat.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
            stats.blocked++;
            chrome.storage.local.set({ blocked: stats.blocked });
            const blockUrl = chrome.runtime.getURL("blocked.html") + "?domain=" + encodeURIComponent(hostname) + "&category=" + encodeURIComponent(displayCat) + "&orgId=" + encodeURIComponent(config.orgId);
            chrome.tabs.update(details.tabId, { url: blockUrl });
            logRequest(hostname, "blocked", displayCat, url);
          }
        }
      });
    }
  }
});

// Check if domain is in any known list (skip dynamic check if so)
function isKnownDomain(hostname) {
  for (const domainSet of Object.values(CATEGORY_DOMAINS)) {
    if (matchesDomainInSet(hostname, domainSet)) return true;
  }
  if (matchesDomain(hostname, policy.blockedDomains)) return true;
  if (matchesDomain(hostname, policy.allowedDomains)) return true;
  return false;
}

// Also intercept completed navigations for SafeSearch on redirects
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !config.enrolled) return;
  if (policy.safeSearch) {
    const safeUrl = enforceSafeSearch(details.url);
    if (safeUrl && safeUrl !== details.url) {
      chrome.tabs.update(details.tabId, { url: safeUrl });
      return;
    }
  }
  if (policy.disableAIOverview) {
    const noAIUrl = enforceDisableAIOverview(details.url);
    if (noAIUrl && noAIUrl !== details.url) {
      chrome.tabs.update(details.tabId, { url: noAIUrl });
    }
  }
});

// ============================================================
// Logging (batched, with full URL and search queries)
// ============================================================

let logQueue = [];
let logTimer = null;

function logRequest(domain, action, category, url, searchQuery, searchEngine) {
  const entry = {
    domain,
    action,
    category: category || "",
    url: url || "",
    type: "navigation",
    method: "GET",
    deviceIP: "",
    deviceName: config.deviceName || "",
    udid: config.deviceId || "",
    userEmail: config.userEmail || "",
    timestamp: new Date().toISOString(),
    source: "chrome-extension",
    deviceId: config.deviceId,
  };
  if (searchQuery) {
    entry.searchQuery = searchQuery;
    entry.searchEngine = searchEngine || "";
  }
  logQueue.push(entry);
  // Cap queue at 500 entries — drop oldest to bound memory
  if (logQueue.length > 500) {
    logQueue.splice(0, logQueue.length - 500);
  }

  // Batch log every 10 seconds
  if (!logTimer) {
    logTimer = setTimeout(flushLogs, 10000);
  }
}

async function flushLogs() {
  logTimer = null;
  if (!config.enrolled || logQueue.length === 0) return;

  const batch = logQueue.splice(0, 50);
  try {
    // Single batched API call (api.writeLogs wraps arrays natively)
    await api.writeLogs(config.orgId, batch);
  } catch (e) {
    console.error("Log batch failed:", e);
  }

  if (logQueue.length > 0) {
    logTimer = setTimeout(flushLogs, 10000);
  }
}

// ============================================================
// Active Tab Tracking (for Screen View / Live Feed)
// ============================================================

function isTrackableUrl(url) {
  return !!url && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("edge://") && !url.startsWith("about:");
}

async function updateForegroundState(tab, reason = "event") {
  if (!config.enrolled || !tab || !isTrackableUrl(tab.url)) return;
  deviceState.currentURL = tab.url || "";
  deviceState.currentTitle = tab.title || "";
  deviceState.currentFavicon = tab.favIconUrl || "";
  deviceState.activeTabId = tab.id ?? null;
  deviceState.lastTabUpdate = Date.now();

  // Device state sent via periodic heartbeat — no separate write needed
  // Local state tracked for classroom activity updates
}

async function pollActiveTabTruth() {
  if (!config.enrolled) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && isTrackableUrl(tab.url)) {
      await updateForegroundState(tab, "poll");
    }
  } catch (e) {
    console.error("active tab truth poll failed:", e);
  }
}

async function handleInternalGamePages(tabId, url) {
  if (!config.enrolled || !url) return false;

  const isChromeDino = url === "chrome://dino" || url.startsWith("chrome://dino/");
  if (!isChromeDino) return false;

  // Respect game-blocking policy; default ON for schools.
  const gameBlockingEnabled = policy.blockGames !== false;
  if (!gameBlockingEnabled) return false;

  const bDomain = "chrome://dino";
  const bCategory = "Gaming: Chrome Dino";
  const bOrgId = config.orgId || "";
  const blockUrl = chrome.runtime.getURL("blocked.html") +
    "?domain=" + encodeURIComponent(bDomain) +
    "&category=" + encodeURIComponent(bCategory) +
    "&orgId=" + encodeURIComponent(bOrgId);

  try {
    await chrome.tabs.update(tabId, { url: blockUrl });
  } catch (e) {
    console.error("Failed to redirect chrome://dino:", e);
  }

  stats.blocked++;
  await chrome.storage.local.set({ blocked: stats.blocked });
  logRequest("chrome://dino", "blocked", bCategory, url);
  return true;
}

chrome.tabs.onActivated.addListener(async (info) => {
  if (!config.enrolled) return;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (await handleInternalGamePages(info.tabId, tab.url || "")) return;
    await updateForegroundState(tab, "activated");
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!config.enrolled || !tab.active) return;
  if (await handleInternalGamePages(tabId, tab.url || changeInfo.url || "")) return;

  // Catch URL/title changes, including SPA-ish updates where title changes after load.
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title || changeInfo.favIconUrl) {
    await updateForegroundState(tab, changeInfo.status === "complete" ? "updated-complete" : "updated-partial");
  }
});

chrome.windows.onFocusChanged.addListener(async () => {
  await pollActiveTabTruth();
});

// ============================================================
// Message Handler (popup <-> background)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "getStatus":
        const clData = await chrome.storage.local.get([
          ...CLASSROOM_STATE_KEYS, "classroomTeacher", "classroomName",
        ]);
        sendResponse({
          enrolled: config.enrolled,
          orgId: config.orgId,
          deviceId: config.deviceId,
          deviceName: config.deviceName,
          stats,
          policyCategories: policy.blockedCategories,
          safeSearch: policy.safeSearch,
          version: AGENT_VERSION,
          // Report the EFFECTIVE mode, not the raw stored one. The popup and
          // the dashboard must not claim a device is in focus mode while the
          // gate is correctly declining to enforce an expired lease — that
          // divergence is how "visible control, absent enforcement" bugs get
          // diagnosed backwards (#551).
          classroomMode: effectiveClassroomMode(clData),
          classroomTeacher: clData.classroomTeacher || "",
          classroomName: clData.classroomName || "",
          currentURL: deviceState.currentURL,
          currentTitle: deviceState.currentTitle,
          sessionActive: !!classroomSession,
          lastCommandType: deviceState.lastCommandType,
          lastCommandAt: deviceState.lastCommandAt,
        });
        break;
      case "enroll":
        const result = await enroll(msg.orgId, msg.deviceName);
        sendResponse({ success: true, ...result });
        break;
      case "unenroll": {
        // Check managed storage first (admin-set, can't be tampered with)
        // Then fall back to local storage orgSettings
        let allowUnenroll = false;
        try {
          const managed = await chrome.storage.managed.get(["allowUnenroll"]);
          if (managed.allowUnenroll !== undefined) {
            allowUnenroll = managed.allowUnenroll === true;
          } else {
            const unenrollData = await chrome.storage.local.get("orgSettings");
            const orgSettings = unenrollData.orgSettings || {};
            allowUnenroll = orgSettings.allowUnenroll === true;
          }
        } catch {
          const unenrollData = await chrome.storage.local.get("orgSettings");
          const orgSettings = unenrollData.orgSettings || {};
          allowUnenroll = orgSettings.allowUnenroll === true;
        }
        if (!allowUnenroll) {
          sendResponse({ success: false, error: "Organization does not allow unenrollment" });
          break;
        }
        await unenroll();
        sendResponse({ success: true });
        break;
      }
      case "syncPolicies":
        await syncPolicies();
        sendResponse({ success: true, policy });
        break;
      case "AI_CHAT_LOG":
        await handleAiChatLog(msg.data);
        sendResponse({ success: true });
        break;
      case "GET_DISTRACTION_POLICY":
        sendResponse({
          enabled: policy.distractionHidingEnabled === true,
          enrolled: config.enrolled,
        });
        break;
      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true; // async response
});

// ============================================================
// AI Chat Monitoring — Log Handler
// ============================================================

const aiLogQueue = [];
let aiLogFlushTimer = null;
let lastAiLogTime = 0;
const AI_LOG_RATE_MS = 5000;

async function handleAiChatLog(data) {
  if (!config.enrolled || !config.orgId || !data) return;

  const now = Date.now();
  const entry = {
    platform: data.platform || "Unknown",
    promptText: data.promptText || "",
    responseText: data.responseText || "",
    promptLength: data.promptLength || 0,
    responseLength: data.responseLength || 0,
    timestamp: data.timestamp || new Date().toISOString(),
    url: data.url || "",
    conversationId: data.conversationId || "",
    userEmail: config.userEmail || "",
    deviceId: config.deviceId || "",
    deviceName: config.deviceName || "",
    source: "chrome-extension",
    flagged: data.flagged || false,
    flagReason: data.flagReason || "",
    reviewed: false,
  };

  // Rate limit
  if (now - lastAiLogTime < AI_LOG_RATE_MS) {
    aiLogQueue.push(entry);
    if (!aiLogFlushTimer) {
      aiLogFlushTimer = setTimeout(flushAiLogs, 30000);
    }
    return;
  }

  lastAiLogTime = now;
  await writeAiLog(entry);
}

async function writeAiLog(entry) {
  try {
    await api.writeAiChatLog(config.orgId, entry);
    console.log(`🧠 AI Chat logged: [${entry.platform}] ${entry.flagged ? "⚠️ FLAGGED: " + entry.flagReason : ""} ${(entry.promptText || entry.responseText || "").slice(0, 80)}...`);

    // If flagged, also create a PulseAlert for visibility
    if (entry.flagged && entry.flagReason) {
      await api.writePulseAlert(config.orgId, {
        type: "ai-chat",
        source: "chrome-extension",
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        userEmail: config.userEmail || "",
        domain: entry.platform,
        url: entry.url,
        searchQuery: entry.promptText.slice(0, 200),
        category: entry.flagReason,
        severity: entry.flagReason === "self-harm" ? "critical" : entry.flagReason === "academic-dishonesty" ? "high" : "medium",
        // NOT `[entry.flagReason]`. flagReason is the CATEGORY NAME
        // ("self-harm"), not anything the student typed, and matchedTerms is
        // rendered to a counselor as the phrase the student wrote. Sending it
        // here made every AI-chat alert claim a student wrote "self-harm".
        //
        // The category already travels in `category` above, so nothing is lost
        // by omitting it -- the alert keeps its severity, its category and its
        // prompt excerpt, and simply stops asserting a phrase it cannot show.
        // The server enforces this too (proxy/pulse_existence.go); this is the
        // client-side half so the false claim is never even transmitted.
        matchedTerms: [],
        action: "flagged",
        status: "new",
        timestamp: entry.timestamp,
      });
    }
  } catch (e) {
    console.error("AI chat log write failed:", e);
  }
}

async function flushAiLogs() {
  aiLogFlushTimer = null;
  while (aiLogQueue.length > 0) {
    const entry = aiLogQueue.shift();
    await writeAiLog(entry);
  }
}

// ============================================================
// Classroom Session Support
// ============================================================

let classroomSession = null;
let classroomPollInterval = null;

// ── CLASSROOM LEASE (TTL) ───────────────────────────────────────────────────
//
// 🔴 2026-09-08, Excel Academy — 11 Chromebooks STRANDED IN FOCUS FOR 3d 20h.
//
// The bug class this closes: **device-local enforcing state with no expiry.**
// `chrome.storage.local.classroomMode` is the value that actually enforces
// filtering on the device. It had NO expiry, and it has more than one writer.
// A one-off focus command (handleFocusModeCommand) wrote storage but never
// touched the in-memory `classroomSession`; the reconciler compared in-memory
// against the server and so never looked at storage. Storage stayed "focus"
// forever. On 2.51.0 there is no self-heal guard at all, and MV3 evicts this
// worker every ~30s, so the only clear path could never fire again.
//
// Net effect: a stale ENFORCING value survived indefinitely with no path back
// to correct. Relief required a human queueing an out-of-band unlock command.
//
// The fix is to make enforcement a LEASE rather than a fact. Enforcing state
// is valid only until `classroomLeaseExpiresAt`, renewed every time the server
// is successfully consulted. When the lease lapses the device stops honouring
// the local classroom state and falls back to SERVER-TRUTH ORG POLICY. The
// worst case degrades from "wrong forever" to "briefly wrong".
//
// ── WHY 10 MINUTES ─────────────────────────────────────────────────────────
// Chosen from the renewal intervals this file actually runs, not a round guess:
//
//   heartbeat alarm      30s   (chrome.alarms — SURVIVES worker eviction)
//   commandPoll alarm    30s   (chrome.alarms — survives eviction)
//   policySync alarm     60s   (chrome.alarms — survives eviction)
//   classroom poll       10s   (setInterval — DIES on eviction)
//
// The renewal carrier must be an ALARM, never the 10s setInterval. That is the
// precise reason 2.51.0 could not recover: `startClassroomPoll()` installs a
// setInterval, which does not survive eviction, so on a device being evicted
// every ~30s the interval-driven path is effectively dead. Alarms do survive
// and are what re-arm the worker. A TTL renewed only by the interval would
// reproduce the original defect with extra steps.
//
// At a 30s carrier, a 10-minute lease is 20 consecutive renewal opportunities.
// Sizing between the two failure costs:
//
//   * Too short → a teacher's live lesson drops focus on a flaky-wifi morning.
//     The existing tolerance for genuine unreachability is
//     CLASSROOM_POLL_FAILURE_LIMIT = 12 polls ≈ 2 minutes. 10 minutes is 5x
//     that, so no transient outage the code already tolerates can expire a
//     lease that the failure-limit path would have kept.
//   * Too long → students stay wrongly blocked. A class period is ~45 minutes,
//     so the lease must expire well inside one lesson; 10 minutes cannot
//     outlive the period that created it. It also sits inside the proxy's
//     1-hour command delivery TTL, so recovery never waits on a queued row.
//
// MISSING LEASE COUNTS AS EXPIRED — deliberately, and it is load-bearing.
// The ~113 active devices on 2.51.0 hold `classroomMode` with no lease field
// at all. Treating absent as expired is what lets those devices unstrand
// themselves on upgrade with no store release, no deploy and no human. Every
// enforcing writer in this file stamps a lease, so a legitimately active
// session re-establishes one on its next poll (~10s).
const CLASSROOM_LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes; see sizing above.

/** Storage keys that together make up device-local classroom enforcing state. */
const CLASSROOM_STATE_KEYS = [
  "classroomMode",
  "classroomAllowedDomains",
  "classroomBlockedDomains",
  "classroomLeaseExpiresAt",
];

/** The cleared (non-enforcing) classroom state, lease included. */
function clearedClassroomState(extra = {}) {
  return {
    classroomMode: "none",
    classroomAllowedDomains: [],
    classroomBlockedDomains: [],
    classroomLeaseExpiresAt: 0,
    ...extra,
  };
}

/** A lease stamp `CLASSROOM_LEASE_TTL_MS` from now. */
function classroomLeaseStamp(now = Date.now()) {
  return now + CLASSROOM_LEASE_TTL_MS;
}

/**
 * Is a stored classroom lease still valid?
 *
 * PURE, and deliberately so: the enforcement gate calls this on every
 * navigation, and a helper that could throw or await would become a new way to
 * fail. Absent/zero/NaN/non-numeric all read as EXPIRED — see the note above on
 * why absent must not mean "valid forever".
 */
function isClassroomLeaseValid(stored, now = Date.now()) {
  const raw = stored ? stored.classroomLeaseExpiresAt : undefined;
  const exp = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return exp > now;
}

/**
 * The classroom mode the device may actually ENFORCE right now.
 *
 * ⚠️ FAIL SAFE, NOT FAIL OPEN. This returns "none" for an expired lease, and
 * "none" means "no CLASSROOM restriction" — it does NOT mean "no filtering".
 * The enforcement gate falls through from here into checkUrl(), the normal
 * org-policy path, so an expired lease returns the device to SERVER-TRUTH
 * POLICY. Every org block, category block and keyword block still applies.
 * These are K-12 devices; expiry must never unblock a site a school blocks.
 *
 * Modes are only ever RELAXED to "none", never escalated: an expired lease
 * cannot invent an enforcing mode the server never sanctioned.
 */
function effectiveClassroomMode(stored, now = Date.now()) {
  const mode = (stored && stored.classroomMode) || "none";
  if (mode === "none") return "none";
  return isClassroomLeaseValid(stored, now) ? mode : "none";
}

// True when chrome.storage.local still holds an enforcing classroom mode.
//
// The focus/lockdown blocking checks read these keys, and they survive
// service-worker eviction. The in-memory session object does not. Any
// "did the session end" decision must therefore consult storage, or a
// restarted worker can never release a block it is still enforcing.
async function hasStaleClassroomState() {
  try {
    const s = await chrome.storage.local.get(["classroomMode"]);
    const m = s && s.classroomMode;
    return !!m && m !== "none";
  } catch (e) {
    // Never let this break the only code path that can clear a stale block.
    return false;
  }
}

// Consecutive pollClassroomSession() failures. Reset on any successful poll.
//
// 🔴 See the catch block at the end of pollClassroomSession for the incident.
// The limit is a COUNT of consecutive failures rather than a wall-clock
// timeout because MV3 evicts this worker constantly: a timestamp comparison
// would have to survive eviction in storage, while the poll interval (10s)
// makes a count a predictable ~2 minutes of genuine unreachability.
//
// Deliberately not 1: a single flaky poll must not drop a teacher's live
// lesson. Deliberately not large: every extra attempt is another 10s of
// students blocked by a session that may no longer exist.
let classroomPollFailures = 0;
const CLASSROOM_POLL_FAILURE_LIMIT = 12; // ~2 minutes at the 10s poll interval

/**
 * Reap an expired classroom lease from storage.
 *
 * 🔴 THIS MUST BE ALARM-DRIVEN. The enforcement gate already refuses to honour
 * an expired lease, so filtering is correct the moment it lapses even if this
 * never runs. But leaving the dead value in storage keeps the device reporting
 * a mode it is not enforcing, and keeps `isDeviceLocked` re-armable on wake.
 * Called from the `heartbeat` alarm (30s), which SURVIVES MV3 eviction — unlike
 * the 10s setInterval in startClassroomPoll(), whose death is exactly why
 * 2.51.0 could never self-heal.
 *
 * Fail-safe: this only ever moves storage toward the cleared state. It cannot
 * create or escalate an enforcing mode, and it never touches org policy.
 *
 * @returns {Promise<boolean>} true when an expired lease was cleared.
 */
async function reapExpiredClassroomLease() {
  try {
    const stored = await chrome.storage.local.get(CLASSROOM_STATE_KEYS);
    const mode = (stored && stored.classroomMode) || "none";
    if (mode === "none") return false;
    if (isClassroomLeaseValid(stored)) return false;

    console.warn(
      `📚 Classroom lease expired (mode=${mode}) — releasing device-local ` +
      "classroom state and falling back to org policy"
    );
    classroomSession = null;
    await chrome.storage.local.set(clearedClassroomState({
      classroomTeacher: "", classroomName: "",
    }));
    deviceState._lastPushedURL = null;
    clearLockState();
    return true;
  } catch (e) {
    // Never let the reaper become a new way to stay stuck. The gate in
    // effectiveClassroomMode() is already refusing to enforce, so a throw here
    // costs tidiness, not correctness.
    console.error("Classroom lease reap failed:", e);
    return false;
  }
}

async function pollClassroomSession() {
  if (!config.enrolled) return;

  try {
    // Check for active sessions that include this device
    // Use proxy classroom session endpoint
    const sessionRes = await api.get(`/api/classroom/session?orgId=${encodeURIComponent(config.orgId)}&deviceId=${encodeURIComponent(config.deviceId)}&email=${encodeURIComponent(config.userEmail)}`);
    const sessions = sessionRes ? (Array.isArray(sessionRes) ? sessionRes : [sessionRes]).filter(s => s && s.id) : [];

    const activeSession = sessions.find(
      (s) => s.status === "active" && 
        (s.deviceIds || []).includes(config.deviceId) &&
        !(s.excludedDevices || []).includes(config.deviceId)
    );

    // Detect mode/domain changes within the same session
    const sessionChanged = activeSession && classroomSession &&
      classroomSession.id === activeSession.id &&
      (classroomSession.mode !== activeSession.mode ||
       JSON.stringify(classroomSession.allowedDomains || []) !== JSON.stringify(activeSession.allowedDomains || []) ||
       JSON.stringify(classroomSession.blockedDomains || []) !== JSON.stringify(activeSession.blockedDomains || []) ||
       classroomSession.pushURL !== activeSession.pushURL);

    // 🔴 Excel Academy live report — STUCK IN FOCUS WHILE THE SESSION IS MONITOR.
    //
    //     "students are stuck in focus mode but the only sessions we have
    //      running are monitor sessions"
    //
    // `sessionChanged` above compares the IN-MEMORY session object against the
    // server. That is not what the device enforces. The BLOCKING path reads
    // chrome.storage.local (classroomMode / classroomAllowedDomains /
    // classroomBlockedDomains), and storage has a SECOND writer:
    // handleFocusModeCommand() writes {classroomMode:"focus"} for a one-off
    // teacher command and never touches `classroomSession`.
    //
    // So after a one-off Focus command inside a monitor-mode session:
    //   storage.classroomMode = "focus"   ← what is actually enforced
    //   classroomSession.mode = "monitor" ← matches the server, so no "change"
    //   server                = "monitor"
    // Every branch declined to act: `sessionChanged` false (in-memory ===
    // server), the joined-a-new-session branch false (same id), and the clear
    // branch false (activeSession is truthy). Nothing rewrote storage, so the
    // device enforced focus indefinitely — surviving MV3 eviction, because
    // storage survives and the server never contradicted it.
    // hasStaleClassroomState() could not help: it is only consulted when there
    // is NO active session. This was the unguarded hole.
    //
    // Fix: reconcile against STORAGE, the effective source of truth, not only
    // against the in-memory object.
    //
    // ── PRECEDENCE (deliberate) ────────────────────────────────────────────
    // While a session IS active, the SERVER's session state wins. A one-off
    // command still applies instantly and still works for its purpose — it
    // just cannot strand a device in an enforcing mode forever, because the
    // next poll re-converges storage to the mode the class is actually in.
    // A teacher who wants a lasting focus mode changes the SESSION mode, which
    // is authoritative and visible in the UI; a transient button press is not
    // allowed to silently outlive the lesson it was pressed in.
    // With NO active session there is no server mode to reconcile against, so
    // this block does not apply and the #2 stale-state release governs instead.
    let storageDiverged = false;
    if (activeSession) {
      try {
        const enforced = await chrome.storage.local.get(CLASSROOM_STATE_KEYS);
        // Mirror applyClassroomMode's own defaults exactly, or convergence
        // would never reach a fixed point and every poll would rewrite storage.
        //
        // An expired/missing lease is ALSO divergence (#551): a device in a
        // genuine session whose lease lapsed must be re-leased, or the gate
        // keeps declining to enforce a mode the server does sanction. This is
        // the renewal path for a live lesson — it converges within one poll
        // (~10s), and it can only ever restore SERVER-CONFIRMED state.
        const leaseStale = !isClassroomLeaseValid(enforced);
        storageDiverged =
          leaseStale ||
          (enforced.classroomMode || "none") !== (activeSession.mode || "monitor") ||
          JSON.stringify(enforced.classroomAllowedDomains || []) !== JSON.stringify(activeSession.allowedDomains || []) ||
          JSON.stringify(enforced.classroomBlockedDomains || []) !== JSON.stringify(activeSession.blockedDomains || []);
        if (storageDiverged) {
          console.warn(
            `📚 Classroom state desync: storage=${enforced.classroomMode || "none"} ` +
            `server=${activeSession.mode || "monitor"} — re-applying the server's session state`
          );
        }
      } catch (e) {
        // A storage read failure must not cause enforcement churn, and must not
        // count as a poll failure — the server WAS reached successfully.
        console.error("Classroom storage reconcile read failed:", e);
        storageDiverged = false;
      }
    }

    // Whether this poll already wrote the server's state to storage, so the
    // reconcile below does not issue a redundant duplicate write.
    let appliedThisPoll = false;

    if (sessionChanged) {
      // Session mode/domains changed — re-apply
      classroomSession = activeSession;
      console.log(`📚 Session updated: ${activeSession.className} mode=${activeSession.mode}`);
      applyClassroomMode(activeSession);
      appliedThisPoll = true;
    }

    if (activeSession && (!classroomSession || classroomSession.id !== activeSession.id)) {
      // Joined a new session
      classroomSession = activeSession;
      deviceState.lastSessionAckAt = new Date().toISOString();
      deviceState.lastCommandType = "joinSession";
      deviceState.lastCommandAt = deviceState.lastSessionAckAt;
      console.log(`📚 Joined classroom: ${activeSession.className} by ${activeSession.teacherName} [${activeSession.mode}]`);
      applyClassroomMode(activeSession);
      appliedThisPoll = true;
      startScreenshotCapture();
      startCommandPolling();
      startChatPolling();
    } else if (!activeSession && (classroomSession || await hasStaleClassroomState())) {
      // The `|| await hasStaleClassroomState()` half is LOAD-BEARING (2026-08-31).
      //
      // MV3 evicts this service worker after ~30s, resetting the in-memory
      // `classroomSession` to null. But the BLOCKING path reads
      // chrome.storage.local.classroomMode, which SURVIVES eviction. So the old
      // condition `!activeSession && classroomSession` could never fire after a
      // wake: storage was never cleared and the device kept enforcing an
      // allow-list the server had already deleted -- permanently, including the
      // school's own newtab page.
      //
      // Measured at Excel Academy: a student on 2.51.0 was still blocked two
      // hours after every session row was ended server-side. 2.51.0 restarts
      // capture and heartbeat on wake but does NOT restore this, so a version
      // bump does not fix it, and no server-side change can reach it.
      // Left session
      console.log("📚 Left classroom session");
      classroomSession = null;
      deviceState.lastSessionAckAt = new Date().toISOString();
      deviceState.lastCommandType = "leaveSession";
      startScreenViewMonitoring(); // Resume lower-frequency monitoring
      deviceState.lastCommandAt = deviceState.lastSessionAckAt;
      // Restore normal filtering
      chrome.storage.local.set(clearedClassroomState({ classroomTeacher: "", classroomName: "" }));
      deviceState._lastPushedURL = null;
      stopScreenshotCapture();
      stopCommandPolling();
      stopChatPolling();
      clearLockState();
    }

    // The desync repair itself. Runs only when an active session's authoritative
    // state was NOT already written above, so a device enforcing a mode the
    // server does not sanction converges back within one poll (~10s).
    if (activeSession && storageDiverged && !appliedThisPoll) {
      applyClassroomMode(activeSession);
    }

    // A poll that got this far reached the server and applied its answer, so
    // the failure streak is over. Reset BEFORE the activity write below, which
    // is reporting-only: a failure there must not count toward releasing a
    // session the server just confirmed.
    classroomPollFailures = 0;

    // Report activity to session if active
    if (classroomSession) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && isTrackableUrl(tab.url)) {
        await updateForegroundState(tab, "session-poll");
      }
      await api.writeSessionActivity(config.orgId, classroomSession.id, config.deviceId, {
          deviceName: config.deviceName,
          currentURL: deviceState.currentURL || tab?.url || "idle",
          currentTitle: deviceState.currentTitle || tab?.title || "",
          currentFavicon: deviceState.currentFavicon || tab?.favIconUrl || "",
          currentApp: "Google Chrome",
          lastUpdate: new Date().toISOString(),
          sessionMode: classroomSession.mode || "monitor",
          freshnessSeconds: deviceState.lastTabUpdate ? Math.floor((Date.now() - deviceState.lastTabUpdate) / 1000) : 999,
      });
    }
  } catch (e) {
    // 🔴 2026-09-03, Excel Academy report #2 — A THROW MUST NOT PIN STUDENTS
    // INTO FOCUS MODE FOREVER.
    //
    // "we have google classroom stating it's blocked by focus, but as far as I
    // can see there are no active sessions"
    //
    // Measured on prod that day: focus-mode blocking fired 101 times at Excel
    // across 34 students while class_sessions held ZERO active rows and ZERO
    // sessions had been started all day. Enforcement with no session to justify
    // it. background.js:2108 is the only writer of the observed
    // "Classroom: Focus Mode" category, so the enforcing state was client-side.
    //
    // This catch used to only console.error. The enforcing state lives in
    // chrome.storage.local, which SURVIVES MV3 service-worker eviction, and the
    // blocking path reads it directly — so returning here left the device
    // filtering against a session the server had already ended, with no way for
    // the server to release it (the server is precisely what it could not
    // successfully consult).
    //
    // A null/error RESPONSE already cleared correctly, because api.get()
    // swallows fetch failures and returns null, which reaches the clearing
    // branch above. Only a THROW skipped it. Throws are real on this path:
    // deviceAuthHeaders(), chrome.storage reads, and the awaited chrome.* calls
    // later in this body can all throw.
    //
    // The rule, mirroring the policyReady gate (policy-readiness.test.js): a
    // failure to CONFIRM a session is "unknown", not "keep enforcing". Unknown
    // is bounded. We do NOT clear instantly on the first error — a teacher's
    // live lesson must survive one flaky poll — but we refuse to enforce past a
    // grace window on nothing but stale state.
    console.error("Classroom poll error:", e);
    try {
      classroomPollFailures++;
      if (
        classroomPollFailures >= CLASSROOM_POLL_FAILURE_LIMIT &&
        (await hasStaleClassroomState())
      ) {
        console.warn(
          `📚 Releasing stale classroom state after ${classroomPollFailures} consecutive poll failures — ` +
          "refusing to enforce focus mode on unconfirmed state"
        );
        classroomSession = null;
        chrome.storage.local.set(clearedClassroomState({
          classroomTeacher: "", classroomName: "",
        }));
        deviceState._lastPushedURL = null;
        stopScreenshotCapture();
        stopCommandPolling();
        stopChatPolling();
        clearLockState();
        startScreenViewMonitoring();
        classroomPollFailures = 0;
      }
    } catch (inner) {
      // Never let the release path itself become a new way to stay stuck.
      console.error("Classroom stale-state release failed:", inner);
    }
  }
}

function applyClassroomMode(session) {
  const mode = session.mode || "monitor";
  const allowed = session.allowedDomains || [];
  const blocked = session.blockedDomains || [];
  const now = new Date().toISOString();

  deviceState.lastCommandType = `classroom:${mode}`;
  deviceState.lastCommandAt = now;

  chrome.storage.local.set({
    classroomMode: mode,
    classroomAllowedDomains: allowed,
    classroomBlockedDomains: blocked,
    classroomTeacher: session.teacherName || "Teacher",
    classroomName: session.className || "Class",
    classroomSessionId: session.id || "",
    // Renew the lease. This is the ONLY reason a live lesson keeps enforcing:
    // applyClassroomMode runs from a poll that successfully reached the server,
    // so a fresh stamp here means "the server confirmed this mode just now".
    classroomLeaseExpiresAt: classroomLeaseStamp(),
  });

  // Handle push URL (only open if not already consumed)
  if (session.pushURL && session.pushURL !== deviceState._lastPushedURL) {
    deviceState.lastCommandType = "pushURL";
    deviceState.lastCommandAt = now;
    deviceState._lastPushedURL = session.pushURL;
    chrome.tabs.create({ url: session.pushURL, active: true });
  }

  // Handle lockdown mode
  if (mode === "lockdown" || mode === "locked") {
    // Navigate all tabs to block page with lock message
    const msg = session.message || `Device locked by ${session.teacherName}`;
    const lockUrl =
      chrome.runtime.getURL("blocked.html") +
      "?domain=locked&category=" +
      encodeURIComponent("🔒 " + msg) +
      "&orgId=" +
      encodeURIComponent(config.orgId);
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((t) => chrome.tabs.update(t.id, { url: lockUrl }));
    });
  }
}

function startClassroomPoll() {
  if (classroomPollInterval) clearInterval(classroomPollInterval);
  // Poll every 10 seconds for session changes
  classroomPollInterval = setInterval(pollClassroomSession, 10000);
  pollClassroomSession(); // immediate first poll
}

// Start classroom polling when enrolled (enrollment state lives in sync storage as orgId)
chrome.storage.sync.get("orgId", (data) => {
  if (data.orgId) startClassroomPoll();
  // Also restore lock state if it was locked before service worker restart
  chrome.storage.local.get(["classroomMode", "lockMessage", "classroomLeaseExpiresAt"], (stored) => {
    // Second wake-time restore of enforcing state — same lease gate as the
    // loadConfig() path above. Both must check, or the un-gated one becomes the
    // way a stranded lock survives (#551).
    if (stored.classroomMode === "locked" && isClassroomLeaseValid(stored)) {
      isDeviceLocked = true;
      console.log("🔒 Restored lock state from storage");
    } else if (stored.classroomMode === "locked") {
      console.warn(
        "🔒 Lock state in storage has an expired lease — not restoring; " +
        "falling back to org policy"
      );
    }
  });
});

console.log(`🛡️ KyberGate Extension v${AGENT_VERSION} loaded`);

// ============================================================
// Device Location Tracking
// ============================================================

let locationAlarmName = "locationReport";
let isLostMode = false;
let offscreenCreating = null;

// Ensure offscreen document exists for geolocation
async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  }).catch(() => []);

  if (existingContexts && existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["GEOLOCATION"],
    justification: "Get device location for school device tracking",
  });

  try {
    await offscreenCreating;
  } catch (e) {
    // Already exists or permission error — both are fine
    if (!String(e).includes("Only a single offscreen")) {
      console.warn("📍 Offscreen creation error:", e);
    }
  } finally {
    offscreenCreating = null;
  }
}

// Get device geolocation via offscreen document, fall back to IP-based
async function getDeviceLocation() {
  // Try GPS/WiFi via offscreen document
  try {
    await ensureOffscreen();
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ success: false, error: "timeout" }), 15000);
      chrome.runtime.sendMessage({ type: "getGeolocation" }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: "no response" });
        }
      });
    });

    if (result && result.success) {
      return {
        lat: result.lat,
        lng: result.lng,
        accuracy: result.accuracy,
        source: result.source || "gps",
      };
    }
  } catch (e) {
    console.log("📍 Offscreen geolocation failed:", e);
  }

  // Fallback: IP-based geolocation
  try {
    const res = await fetch("http://ip-api.com/json/?fields=lat,lon,city,regionName,country,query");
    if (res.ok) {
      const data = await res.json();
      return {
        lat: data.lat,
        lng: data.lon,
        accuracy: 5000, // city-level ~5km
        source: "ip",
      };
    }
  } catch (e) {
    console.log("📍 IP geolocation fallback failed:", e);
  }

  return null;
}

// Report device location to proxy
async function reportLocation() {
  if (!config.enrolled) return;

  const location = await getDeviceLocation();
  if (!location) return;

  try {
    await fetch(`${PROXY_BASE}/api/device-location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId: config.orgId,
        deviceId: config.deviceId,
        email: config.userEmail,
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy,
        source: location.source,
      }),
    });
  } catch (e) {
    console.error("📍 Location report failed:", e);
  }
}

// Update location alarm interval based on lost mode status
function updateLocationAlarm() {
  const interval = isLostMode ? 5 : 30; // 5 min in lost mode, 30 min normal
  chrome.alarms.create(locationAlarmName, { periodInMinutes: interval });
}

// Check lost mode status from classroom session API response
function handleLostModeUpdate(lostMode) {
  const wasLost = isLostMode;
  isLostMode = !!lostMode;

  if (isLostMode && !wasLost) {
    // Just entered lost mode — report immediately and increase polling
    console.log("📍🔴 Lost mode ACTIVATED — increasing location reporting");
    reportLocation();
    updateLocationAlarm();
  } else if (!isLostMode && wasLost) {
    console.log("📍🟢 Lost mode DEACTIVATED — resuming normal location reporting");
    updateLocationAlarm();
  }
}

// Start location reporting on enrollment
if (config.enrolled) {
  updateLocationAlarm();
  // Initial location report after a short delay
  setTimeout(reportLocation, 5000);
}

// Add location alarm to existing alarm listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === locationAlarmName && config.enrolled) {
    await reportLocation();
  }
});

// ============================================================
// Screenshot Capture — Live Tab Thumbnails to proxy API
// ============================================================

let screenshotInterval = null;
const SCREENSHOT_INTERVAL_MS = 4000; // 4 seconds during classroom session (matches v2.29)
let _screenshotCanvas = null;
let _screenshotCtx = null;

function getScreenshotCanvas(w = 1280, h = 800) {
  if (!_screenshotCanvas || _screenshotCanvas.width !== w || _screenshotCanvas.height !== h) {
    _screenshotCanvas = new OffscreenCanvas(w, h);
    _screenshotCtx = _screenshotCanvas.getContext("2d");
  }
  return { canvas: _screenshotCanvas, ctx: _screenshotCtx };
}

async function captureAndUploadScreenshot() {
  if (!config.enrolled) return;
  try {
    // Capture visible tab as PNG data URI
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    if (!dataUrl) return;

    // Get active tab info
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    // Resize to 1280x800 JPEG at 80% quality for crisp expanded view
    const blob = await fetch(dataUrl).then(r => r.blob());
    const bmp = await createImageBitmap(blob);
    // Maintain source aspect ratio, fit within 1280x800
    const srcW = bmp.width, srcH = bmp.height;
    const scale = Math.min(1280 / srcW, 800 / srcH, 1); // never upscale
    const dstW = Math.round(srcW * scale), dstH = Math.round(srcH * scale);
    const { canvas, ctx } = getScreenshotCanvas(dstW, dstH);
    ctx.drawImage(bmp, 0, 0, dstW, dstH);
    bmp.close();

    const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });

    // Convert blob to base64 using array buffer
    const arrayBuf = await jpegBlob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    const base64 = btoa(binary);

    // Upload to proxy API
    await api.uploadScreenshot(config.orgId, config.deviceId, {
      userEmail: config.userEmail || "",
      image: base64,
      timestamp: new Date().toISOString(),
      activeTab: {
        url: tab.url || "",
        title: tab.title || "",
        tabId: tab.id || 0,
      },
    });
  } catch (e) {
    // Don't spam console — captureVisibleTab fails on chrome:// pages, etc.
    if (!String(e).includes("Cannot access") && !String(e).includes("No active") && !String(e).includes("activeTab")) {
      console.error("Screenshot capture error:", e);
    }
  }
}

function startScreenshotCapture() {
  stopScreenshotCapture();
  stopScreenViewMonitoring(); // Classroom mode takes over — higher frequency
  console.log(`📸 Starting classroom screenshot capture (every ${SCREENSHOT_INTERVAL_MS / 1000}s)`);
  captureAndUploadScreenshot(); // immediate first capture
  screenshotInterval = setInterval(captureAndUploadScreenshot, SCREENSHOT_INTERVAL_MS);
}

function stopScreenshotCapture() {
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
    console.log("📸 Stopped screenshot capture");
  }
}

// ============================================================
// ScreenView Monitoring — Always-on screenshot capture for admin dashboard
// Lower frequency when no classroom session active (SCREENVIEW_INTERVAL_MS).
// Higher frequency during classroom sessions (SCREENSHOT_INTERVAL_MS).
//
// ⚠️ 2026-08-28 — These comments and the console.log strings used to hardcode
// "30s" and "8s" while the constants said 15000 and 4000. Both had been retuned
// without updating the prose, so anyone debugging a staleness complaint read the
// log line and reasoned from a cadence the extension has not used in months.
// The strings are now INTERPOLATED FROM THE CONSTANTS so they cannot drift again.
// ============================================================

const SCREENVIEW_INTERVAL_MS = 15000; // 15 seconds passive monitoring (matches v2.29)
let screenViewInterval = null;
// 🔴 The re-entrancy guard MUST cover the 5s startup window, not just the live
// interval (2026-08-29). See startScreenViewMonitoring().
let screenViewStartTimer = null;

// 🔴 2026-08-29 — DOUBLE-START LEAKED AN INTERVAL. Read before touching the guard.
//
// `if (screenViewInterval) return` looks like a re-entrancy guard but does not
// cover the 5s settle delay: for those 5 seconds `screenViewInterval` is still
// null, so a SECOND call sails past the guard. FIVE call sites invoke this
// (enroll x2, startup, the 1-min backup alarm, and resume-after-classroom), so
// overlapping calls are routine, not exotic.
//
// Two consequences, and the second is the bad one:
//   1. Both timers fire captureAndUploadScreenshot() at once → two uploads
//      milliseconds apart. Measured on prod: 5 of 381 Excel devices had two files
//      8ms apart. With SCREENSHOT_KEEP_PER_DEVICE=2 that collapses the retention
//      buffer to effectively ONE file, which is exactly the window where a file
//      gets unlinked between the dashboard's poll and the browser's <img> fetch
//      — /image/ 404s and a teacher stares at a blank tile.
//   2. The second setInterval OVERWRITES the first handle, so the first interval
//      is unreachable and can never be cleared. stopScreenViewMonitoring() then
//      only stops the survivor. The orphan keeps capturing FOREVER, at double
//      rate, including during classroom sessions that explicitly stopped passive
//      monitoring. Every subsequent double-start compounds it.
//
// So the guard tracks the PENDING TIMER as well, and stop() clears both.
function startScreenViewMonitoring() {
  if (screenViewInterval || screenViewStartTimer) return; // already running OR starting
  console.log(`🖥️ Starting ScreenView monitoring (every ${SCREENVIEW_INTERVAL_MS / 1000}s)`);
  // Initial capture after short delay (let enrollment settle)
  screenViewStartTimer = setTimeout(() => {
    screenViewStartTimer = null;
    // Re-check: a classroom session may have called stop() during the settle
    // delay. Without this the "stopped" monitor resurrects itself 5s later and
    // fights the 4s classroom capture.
    if (screenViewInterval) return;
    captureAndUploadScreenshot();
    screenViewInterval = setInterval(captureAndUploadScreenshot, SCREENVIEW_INTERVAL_MS);
  }, 5000);
}

function stopScreenViewMonitoring() {
  // Cancel a start that has not landed yet, or it fires after we "stopped".
  if (screenViewStartTimer) {
    clearTimeout(screenViewStartTimer);
    screenViewStartTimer = null;
  }
  if (screenViewInterval) {
    clearInterval(screenViewInterval);
    screenViewInterval = null;
    console.log("🖥️ Stopped ScreenView monitoring");
  }
}

// ============================================================
// Teacher Command Polling & Processing
// ============================================================

let commandPollInterval = null;
const COMMAND_POLL_MS = 3000;
let isDeviceLocked = false;
const processedCommandIds = new Set();

async function pollTeacherCommands() {
  if (!config.enrolled) return;
  try {
    const commandsRes = await api.getCommands(config.orgId, config.deviceId);
    const commands = commandsRes?.commands || [];
    if (!commands || commands.length === 0) return;

    // Filter unprocessed, sort by timestamp
    const pending = commands
      .filter(c => !c.processed && !processedCommandIds.has(c.id))
      .sort((a, b) => {
        const ta = a.timestamp || a.createdAt || "";
        const tb = b.timestamp || b.createdAt || "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

    for (const cmd of pending) {
      const outcome = await processCommand(cmd);
      // Mark as processed, reporting the REAL outcome (see markCommandProcessed).
      await api.markCommandProcessed(config.orgId, config.deviceId, cmd.id, outcome);
      processedCommandIds.add(cmd.id);
      // Keep set bounded
      if (processedCommandIds.size > 200) {
        const oldest = processedCommandIds.values().next().value;
        processedCommandIds.delete(oldest);
      }
    }
  } catch (e) {
    console.error("Command poll error:", e);
  }
}

async function processCommand(cmd) {
  const type = (cmd.type || cmd.command || "").toLowerCase();
  const now = new Date().toISOString();
  deviceState.lastCommandType = type;
  deviceState.lastCommandAt = now;

  // 🔴 2026-08-26 — P0, Excel Academy (Jeremy Seiferth):
  //   "the 'click to close' function isn't working in Screen View. It 'syncs' but
  //    doesn't close. I tried closing a Google Doodle in my own class and confirmed
  //    it was unsuccessful."
  //
  // This TTL was 60 SECONDS while the server keeps a command pending for 1 HOUR
  // (commandTTL in proxy/postgres.go). Two clocks, one order.
  //
  // Why 60s cannot work under Manifest V3: the 3-second setInterval only runs while
  // the service worker is ALIVE. Chrome evicts an idle MV3 worker after ~30s, and the
  // wake-up is chrome.alarms, whose MINIMUM period is 30s (we ask for 0.5 min). So a
  // sleeping Chromebook wakes, polls, and routinely sees a command that is already
  // 30-90s old — past the 60s cutoff. The command was then dropped on the floor...
  // and acked anyway, so the teacher's UI reported a successful "sync" while nothing
  // happened on the device. Worse for exactly the case that matters: a device idle
  // because the student is off-task is the MOST likely to have a sleeping worker.
  //
  // Fix: honour the server's window instead of inventing a stricter one, and when we
  // do refuse, say so in the ack so it lands as 'failed' rather than 'completed'.
  const COMMAND_MAX_AGE_MS = 60 * 60 * 1000; // matches proxy commandTTL ("1 hour")
  const cmdTime = cmd.timestamp || cmd.createdAt;
  if (cmdTime) {
    const age = Date.now() - new Date(cmdTime).getTime();
    if (age > COMMAND_MAX_AGE_MS) {
      console.warn(`⏰ Rejecting stale command (${Math.round(age/1000)}s old): ${type}`);
      return { status: "failed", error: `stale: ${Math.round(age / 1000)}s old` };
    }
  }

  console.log(`🎓 Processing teacher command: ${type}`, cmd);

  switch (type) {
    // 🔴 2026-09-04 (#421) — RETURN THE OUTCOME, DO NOT `break`.
    //
    // Every case below used to `break`, so processCommand fell through to its
    // implicit `undefined`, markCommandProcessed posted `{}`, and the ack body
    // carried no outcome at all. The server then graded that silence — correctly,
    // per #29 — as unverifiable, which is why prod shows focusMode at
    // 0 completed / 94 failed and pushUrl at 4 / 72.
    //
    // The work HAD happened. The wire simply carried nothing about it. Each
    // handler now reports the effect it committed, in the shape the close
    // handlers already used, and the server grades it against that type's
    // contract (proxy/command_outcome.go: ackContracts).
    case "lock":
      return await handleLockCommand(cmd);
    case "unlock":
      return await handleUnlockCommand();
    case "pushurl":
    case "push_url":
      return await handlePushUrlCommand(cmd);
    case "closetab":
    case "close_tab":
    case "close_all_tabs": {
      // 🔴 2026-08-26 — RETURN the handler's outcome, do not discard it.
      // handleCloseTabCommand now verifies the tabs are actually gone and reports
      // {status:"failed"} when they are not. If we `break` here instead of
      // returning, processCommand falls through to its implicit `undefined`, the
      // ack body is empty, and proxy/api.go's ack handler defaults an empty body
      // to "completed" — which is precisely the "it syncs but doesn't close"
      // false-success Jeremy reported. The verification is worthless unless the
      // result is propagated.
      const closeOutcome = await handleCloseTabCommand(cmd);
      return closeOutcome || { status: "completed" };
    }
    case "focusmode":
    case "focus_mode":
    case "focus":
      return await handleFocusModeCommand(cmd);
    case "focustab":
    case "focus_tab":
      return await handleFocusTabCommand(cmd);
    case "message":
      return await handleMessageCommand(cmd);
    case "announcement":
      return await handleAnnouncementCommand(cmd);
    case "chat":
      return await handleChatNotification(cmd);
    default:
      // An unknown verb did NOTHING. Say so, rather than acking empty and
      // letting the server infer it — an explicit failure names the cause.
      console.warn(`Unknown command type: ${type}`);
      return { status: "failed", error: `unsupported command type: ${type}` };
  }
}

// ── Lock Command ──
async function handleLockCommand(cmd) {
  isDeviceLocked = true;
  const message = cmd.message || "Your screen has been locked by your teacher";

  // Store lock state
  await chrome.storage.local.set({
    classroomMode: "locked",
    lockMessage: message,
    // "locked" blocks EVERY navigation, so it is the most damaging state to
    // strand a device in. It leases like any other enforcing mode.
    classroomLeaseExpiresAt: classroomLeaseStamp(),
  });

  // Inject lock overlay on ALL tabs
  const tabs = await chrome.tabs.query({});
  let overlaid = 0;
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
      injectLockOverlay(tab.id, message);
      overlaid++;
    }
  }

  console.log("🔒 Device locked by teacher");
  // #421: the effect is the committed lock state, which the filtering path reads
  // via classroomMode. The overlay count is reported because it is what the
  // student actually sees — and a lock with 0 overlaid tabs is still a lock (a
  // device sitting on chrome://newtab), so it is NOT downgraded to a failure.
  return { status: "completed", result: `locked ${overlaid} tab(s)` };
}

async function handleUnlockCommand() {
  isDeviceLocked = false;

  await chrome.storage.local.set({
    classroomMode: classroomSession ? (classroomSession.mode || "monitor") : "none",
    lockMessage: "",
    // Unlock derives its mode from server state and can only yield "none" or
    // "monitor", neither of which enforces. Stamp anyway so the record is
    // internally consistent: a mode key is never left with a stale lease from
    // a previous enforcing write.
    classroomLeaseExpiresAt: classroomLeaseStamp(),
  });

  // Remove lock overlay from ALL tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
      removeLockOverlay(tab.id);
    }
  }

  console.log("🔓 Device unlocked by teacher");
  // #421: prod shows 67 unlock rows graded unverified with closeTab's wording.
  // The word "unlocked" is the contract (proxy ackContracts["unlock"]).
  return { status: "completed", result: "unlocked" };
}

function clearLockState() {
  isDeviceLocked = false;
  chrome.storage.local.set({ lockMessage: "" });
  // Remove overlays from all tabs
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(t => {
      if (t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://")) {
        removeLockOverlay(t.id);
      }
    });
  });
}

function injectLockOverlay(tabId, message) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (msg) => {
      // Remove existing overlay if any
      const existing = document.getElementById("kybergate-lock-overlay");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "kybergate-lock-overlay";
      overlay.style.cssText = `
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 100vw !important; height: 100vh !important;
        background: #FAF9F6 !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex-direction: column !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
      `;

      // Build DOM safely — dynamic text via textContent (no innerHTML interpolation)
      const wrap = document.createElement("div");
      wrap.style.cssText = "text-align:center; max-width:480px; padding:48px 32px;";

      const iconWrap = document.createElement("div");
      iconWrap.style.cssText = "width:88px; height:88px; border-radius:50%; background:rgba(224,122,95,0.1); display:flex; align-items:center; justify-content:center; margin:0 auto 24px;";
      // Static SVG (no dynamic content)
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#E07A5F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;

      const h1 = document.createElement("h1");
      h1.style.cssText = "font-size:28px; font-weight:800; color:#1A1A2A; margin-bottom:8px;";
      h1.textContent = "Screen Locked";

      const p = document.createElement("p");
      p.style.cssText = "font-size:15px; color:#6B7280; line-height:1.5; margin-bottom:16px;";
      p.textContent = msg;

      const footer = document.createElement("div");
      footer.style.cssText = "margin-top:48px; font-size:11px; color:#D1D5DB;";
      footer.appendChild(document.createTextNode("Protected by "));
      const brand = document.createElement("span");
      brand.style.cssText = "color:#E07A5F; opacity:0.5;";
      brand.textContent = "KyberGate";
      footer.appendChild(brand);

      wrap.appendChild(iconWrap);
      wrap.appendChild(h1);
      wrap.appendChild(p);
      wrap.appendChild(footer);
      overlay.appendChild(wrap);

      // Block all keyboard shortcuts and interactions
      const blocker = (e) => {
        e.preventDefault();
        e.stopPropagation();
        return false;
      };
      overlay.addEventListener("keydown", blocker, true);
      overlay.addEventListener("keyup", blocker, true);
      document.addEventListener("keydown", blocker, true);

      // Block visibility change (prevent tab switching tricks)
      overlay.setAttribute("tabindex", "0");

      document.body.appendChild(overlay);
      overlay.focus();
    },
    args: [message],
  }).catch(() => {}); // Silently fail for tabs we can't inject into
}

function removeLockOverlay(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const overlay = document.getElementById("kybergate-lock-overlay");
      if (overlay) overlay.remove();
      // Remove keyboard blockers (they auto-cleanup with element removal mostly)
    },
  }).catch(() => {});
}

// Also inject lock on new tabs if device is locked
chrome.tabs.onCreated.addListener(async (tab) => {
  if (isDeviceLocked) {
    // Wait a moment for the page to load enough to inject
    setTimeout(() => {
      const lockMsg = "Your screen has been locked by your teacher";
      chrome.storage.local.get("lockMessage", (data) => {
        injectLockOverlay(tab.id, data.lockMessage || lockMsg);
      });
    }, 1000);
  }
});

// Re-inject lock overlay when a page finishes loading (in case student navigates)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (isDeviceLocked && changeInfo.status === "complete") {
    if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
      const data = await chrome.storage.local.get("lockMessage");
      injectLockOverlay(tabId, data.lockMessage || "Your screen has been locked by your teacher");
    }
  }
});

// ── Push URL Command ──
async function handlePushUrlCommand(cmd) {
  const url = cmd.url || cmd.payload?.url;
  // 🔴 #421 — EVERY REFUSAL PATH BELOW USED TO `return` BARE.
  //
  // A bare return acks with an empty body, which is indistinguishable on the
  // wire from "the agent cannot report outcomes". These are not unverifiable:
  // they are known, named refusals, and a teacher is entitled to the reason.
  if (!url) {
    console.warn("pushUrl command missing url");
    return { status: "failed", error: "pushUrl command missing url" };
  }
  // Validate URL scheme — only allow http/https
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      console.warn(`🚫 Blocked pushUrl with unsafe protocol: ${parsed.protocol}`);
      return { status: "failed", error: `blocked pushUrl with unsafe protocol: ${parsed.protocol}` };
    }
  } catch {
    console.warn(`🚫 Blocked pushUrl with invalid URL: ${url}`);
    return { status: "failed", error: "blocked pushUrl with invalid URL" };
  }
  // ⚠️ AWAITED, and the created tab is confirmed. chrome.tabs.create can reject
  // (no window, url refused by policy) and the un-awaited call swallowed it — the
  // same shape of false success #29 removed from tab closing.
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab || !tab.id) {
      return { status: "failed", error: `pushUrl created no tab for ${url}` };
    }
    console.log(`🌐 Pushed URL: ${url}`);
    // The contract (proxy ackContracts["pushurl"]) requires the url be NAMED:
    // "a tab opened" does not answer the teacher's question of which page.
    return { status: "completed", result: `opened ${url} in a new tab` };
  } catch (e) {
    return { status: "failed", error: `pushUrl failed for ${url}: ${e?.message || e}` };
  }
}

// ── Close Tab Command ──
// Confirm tabs are ACTUALLY gone, rather than trusting that chrome.tabs.remove
// resolved. Returns the ids that are still open.
//
// 🔴 2026-08-26 — P0, Excel Academy (Jeremy Seiferth): "it syncs but doesn't
// close." chrome.tabs.remove() can resolve without the tab going away — a
// beforeunload dialog, a pinned/locked tab, a tab owned by another profile, or
// a tab id that went stale between query and remove. Every one of those paths
// used to land in a `catch` that only did console.warn, so the device reported
// success. Verify, then report what actually happened.
async function stillOpenTabIds(ids) {
  if (!ids || ids.length === 0) return [];
  const wanted = new Set(ids.map(Number));
  try {
    const now = await chrome.tabs.query({});
    return now.map(t => Number(t.id)).filter(id => wanted.has(id));
  } catch (e) {
    // Cannot verify -> do NOT claim success.
    console.warn("Tab verification query failed:", e);
    return ids.map(Number);
  }
}

async function handleCloseTabCommand(cmd) {
  const url = cmd.url || cmd.payload?.url;
  const type = (cmd.type || cmd.command || "").toLowerCase();

  if (type === "close_all_tabs") {
    // Close ALL tabs except one (keep a blank tab)
    const tabs = await chrome.tabs.query({});
    if (tabs.length === 0) {
      return { status: "failed", error: "no tabs open on device" };
    }
    // Keep the first tab, close the rest
    const tabsToClose = tabs.slice(1).map(t => t.id);
    try {
      if (tabsToClose.length > 0) await chrome.tabs.remove(tabsToClose);
      await chrome.tabs.update(tabs[0].id, { url: "chrome://newtab" });
    } catch (e) {
      console.warn("Failed to close all tabs:", e);
      return { status: "failed", error: `close_all_tabs: ${e?.message || e}` };
    }
    const survivors = await stillOpenTabIds(tabsToClose);
    if (survivors.length > 0) {
      return {
        status: "failed",
        error: `${survivors.length} of ${tabsToClose.length} tab(s) did not close`,
      };
    }
    console.log(`🗑️ Closed all tabs (${tabsToClose.length} closed, 1 kept)`);
    return { status: "completed", result: `closed ${tabsToClose.length} tab(s), kept 1` };
  }

  let outcome;

  // ── SELECTOR PRECEDENCE (2026-08-29) ──────────────────────────────────────
  // The dashboard now sends `tabIds` AND `url` together: the id is the precise
  // selector, the url is a fallback for when Chrome has already reclaimed that
  // id. Order matters enormously here.
  //
  // 🔴 `url` MUST NOT win when an id was supplied. The url branch closes EVERY
  // tab whose hostname matches, so preferring it would turn "close this one
  // Canva tab" into "close all six of this student's Canva tabs". That is a
  // silent over-close: destructive, invisible in the command log (it reports
  // success), and it lands on a student mid-lesson. Ids first, url only as a
  // rescue after the id genuinely no longer exists.
  const idsRequested = cmd.tabIds || cmd.payload?.tabIds;
  const hasIdSelector = (Array.isArray(idsRequested) && idsRequested.length > 0) ||
                        cmd.tabId || cmd.payload?.tabId;

  if (url && !hasIdSelector) {
    // Close tabs matching URL pattern
    const tabs = await chrome.tabs.query({});
    const urlLower = url.toLowerCase();
    const tabsToClose = tabs.filter(t => {
      if (!t.url) return false;
      try {
        const tabHost = new URL(t.url).hostname.toLowerCase();
        const targetHost = urlLower.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
        return tabHost === targetHost || tabHost === "www." + targetHost || tabHost.endsWith("." + targetHost);
      } catch {
        return t.url.toLowerCase().includes(urlLower);
      }
    });
    if (tabsToClose.length === 0) {
      // Nothing matched. This is the single most useful signal for the teacher:
      // the student already navigated away, so there was nothing to close.
      // Reporting it as success is what made "it syncs but doesn't close" so
      // confusing to diagnose.
      outcome = { status: "failed", error: `no open tab matched ${url}` };
    } else {
      const ids = tabsToClose.map(t => t.id);
      try {
        await chrome.tabs.remove(ids);
      } catch (e) {
        console.warn("Failed to close tabs:", e);
        outcome = { status: "failed", error: `close by url: ${e?.message || e}` };
      }
      if (!outcome) {
        const survivors = await stillOpenTabIds(ids);
        outcome = survivors.length > 0
          ? { status: "failed", error: `${survivors.length} of ${ids.length} tab(s) matching ${url} did not close` }
          : { status: "completed", result: `closed ${ids.length} tab(s) matching ${url}` };
        if (survivors.length === 0) console.log(`🗑️ Closed ${ids.length} tab(s) matching: ${url}`);
      }
    }
  } else {
    // Close by specific tab ID(s) — dashboard sends tabIds array, legacy sends tabId
    const tabIds = cmd.tabIds || cmd.payload?.tabIds;
    const targetTabId = cmd.tabId || cmd.payload?.tabId;
    if (Array.isArray(tabIds) && tabIds.length > 0) {
      const ids = tabIds.map(Number);
      try {
        await chrome.tabs.remove(ids);
      } catch (e) {
        // 🔴 STALE-ID RESCUE (2026-08-29). This throw is `No tab with id: N` and it
        // was 18 of 19 closeTab failures at Excel Academy — 46.3% of all closes on
        // agents that report truthfully. In every one of those 18 the requested id
        // was OLDER than every tab live on the device (Chrome allocates tab ids
        // monotonically), i.e. the teacher clicked an X on a tab that had already
        // gone, because the dashboard strip can be ~60s behind reality.
        //
        // Before failing, try to honour the teacher's INTENT via the url the
        // dashboard captured alongside the id. Scoped deliberately tight: only the
        // single most recently-opened matching tab, never all matches, so a rescue
        // can never become a mass-close (see the precedence note above).
        const rescueUrl = url;
        let rescued = false;
        if (rescueUrl) {
          try {
            const open = await chrome.tabs.query({});
            const target = rescueUrl.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
            const matches = open.filter(t => {
              if (!t.url) return false;
              try {
                const h = new URL(t.url).hostname.toLowerCase();
                return h === target || h === "www." + target || h.endsWith("." + target);
              } catch { return false; }
            });
            if (matches.length > 0) {
              const victim = matches.reduce((a, b) => (b.id > a.id ? b : a));
              await chrome.tabs.remove(victim.id);
              const left = await stillOpenTabIds([victim.id]);
              if (left.length === 0) {
                rescued = true;
                outcome = { status: "completed", result: `closed 1 tab by url fallback (stale id ${ids.join(",")})` };
                console.log(`🗑️ Stale id ${ids.join(",")} — closed by url fallback: ${rescueUrl}`);
              }
            }
          } catch (fallbackErr) {
            console.warn("closeTab url fallback failed:", fallbackErr);
          }
        }
        if (!rescued) {
          console.warn("Failed to close tabs by ID:", e);
          outcome = { status: "failed", error: `close by ids: ${e?.message || e}` };
        }
      }
      if (!outcome) {
        const survivors = await stillOpenTabIds(ids);
        outcome = survivors.length > 0
          ? { status: "failed", error: `${survivors.length} of ${ids.length} tab(s) did not close (stale tab id or blocked by page)` }
          : { status: "completed", result: `closed ${ids.length} tab(s) by id` };
        if (survivors.length === 0) console.log(`🗑️ Closed ${ids.length} tab(s) by ID: ${ids.join(", ")}`);
      }
    } else if (targetTabId) {
      const id = Number(targetTabId);
      try {
        await chrome.tabs.remove(id);
      } catch (e) {
        console.warn("Failed to close tab:", e);
        outcome = { status: "failed", error: `close tab ${id}: ${e?.message || e}` };
      }
      if (!outcome) {
        const survivors = await stillOpenTabIds([id]);
        outcome = survivors.length > 0
          ? { status: "failed", error: `tab ${id} did not close (stale tab id or blocked by page)` }
          : { status: "completed", result: `closed tab ${id}` };
        if (survivors.length === 0) console.log(`🗑️ Closed tab: ${id}`);
      }
    } else {
      // Close all non-essential tabs (keep one tab open)
      const tabs = await chrome.tabs.query({});
      if (tabs.length <= 1) {
        outcome = { status: "failed", error: "nothing to close (1 or 0 tabs open)" };
      } else {
        const ids = tabs.slice(1).map(t => t.id);
        try {
          await chrome.tabs.remove(ids);
          await chrome.tabs.update(tabs[0].id, { url: "chrome://newtab" });
        } catch (e) {
          console.warn("Failed to close tabs:", e);
          outcome = { status: "failed", error: `close non-essential: ${e?.message || e}` };
        }
        if (!outcome) {
          const survivors = await stillOpenTabIds(ids);
          outcome = survivors.length > 0
            ? { status: "failed", error: `${survivors.length} of ${ids.length} tab(s) did not close` }
            : { status: "completed", result: `closed ${ids.length} tab(s)` };
          if (survivors.length === 0) console.log(`🗑️ Closed ${ids.length} tabs`);
        }
      }
    }
  }

  // Report fresh tab state immediately so dashboards update fast (don't wait for next 30s heartbeat)
  try { await sendHeartbeat(); } catch (e) { console.warn("Post-close heartbeat failed:", e); }

  return outcome;
}

// ── Focus Mode Command ──
async function handleFocusModeCommand(cmd) {
  const allowedDomains = cmd.allowedDomains || cmd.payload?.allowedDomains || cmd.urls || cmd.payload?.urls || [];

  // 🔴 #421 — THE 0-SUCCEEDED / 94-FAILED BUCKET STARTS HERE.
  //
  // This handler committed the state and returned undefined, so the ack body was
  // empty and every focusMode command on the fleet was recorded as a failure
  // while the devices were, in fact, in focus mode. Excel Academy teachers watch
  // that column.
  //
  // ⚠️ The storage write is the EFFECT — the enforcement path reads
  // classroomMode/classroomAllowedDomains from chrome.storage.local — so it is
  // awaited inside a try and a rejection is reported as a failure rather than
  // claimed as success.
  try {
    await chrome.storage.local.set({
      classroomMode: "focus",
      classroomAllowedDomains: allowedDomains,
      // 🔴 THE STRANDING WRITER (#551). This one-off command is what pinned 11
      // Excel devices into focus for 3d 20h: it writes enforcing state without
      // touching `classroomSession`, so the reconciler saw no divergence. It
      // now carries a lease, so the worst case is ~10 minutes of wrongly
      // narrowed browsing instead of permanent lockout. The command still
      // applies instantly and still works for its purpose; a live session
      // renews the lease every poll, so a real lesson is unaffected.
      classroomLeaseExpiresAt: classroomLeaseStamp(),
    });
  } catch (e) {
    return { status: "failed", error: `focus mode not applied: ${e?.message || e}` };
  }

  const count = Array.isArray(allowedDomains) ? allowedDomains.length : 0;
  console.log(`🎯 Focus mode activated. Allowed domains:`, allowedDomains);
  // "focus mode enabled" is the contract (proxy ackContracts["focusmode"]).
  return { status: "completed", result: `focus mode enabled with ${count} allowed domain(s)` };
}

// ── Focus Tab Command (activate a specific tab by ID) ──
async function handleFocusTabCommand(cmd) {
  const tabId = cmd.tabId || cmd.payload?.tabId;
  if (!tabId) {
    console.warn("focusTab: no tabId provided");
    return { status: "failed", error: "focusTab: no tabId provided" };
  }
  try {
    await chrome.tabs.update(Number(tabId), { active: true });
    // Also focus the window containing that tab
    const tab = await chrome.tabs.get(Number(tabId));
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    console.log(`🔍 Focused tab: ${tabId}`);
    // #421: the id is named, so a teacher can tell WHICH tab was brought forward.
    return { status: "completed", result: `focused tab ${Number(tabId)}` };
  } catch (e) {
    // 🔴 This catch only console.warn'd and fell through to an empty ack — a
    // stale tab id (the single most likely failure here) was reported as an
    // unverifiable ack rather than the concrete failure it is.
    console.warn(`focusTab failed for tab ${tabId}:`, e);
    return { status: "failed", error: `focusTab failed for tab ${Number(tabId)}: ${e?.message || e}` };
  }
}

// ── Message Command ──
async function handleMessageCommand(cmd) {
  const message = cmd.message || cmd.payload?.message || "Message from your teacher";
  const title = cmd.title || cmd.payload?.title || "KyberGate — Teacher Message";

  // Try Chrome notifications API first
  try {
    await chrome.notifications.create(`teacher-msg-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: title,
      message: message,
      priority: 2,
      requireInteraction: true,
    });
  } catch (e) {
    console.warn("Notification failed, injecting alert:", e);
  }

  // Also inject a visible banner on the active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith("chrome://")) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg, ttl) => {
          // Remove existing banner
          const existing = document.getElementById("kybergate-message-banner");
          if (existing) existing.remove();

          const banner = document.createElement("div");
          banner.id = "kybergate-message-banner";
          banner.style.cssText = `
            position: fixed !important;
            top: 0 !important; left: 0 !important; right: 0 !important;
            background: linear-gradient(135deg, #E07A5F, #D06A4F) !important;
            color: white !important;
            padding: 16px 24px !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            font-size: 14px !important;
            font-weight: 500 !important;
            z-index: 2147483646 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;
            animation: kyberSlideDown 0.3s ease-out !important;
          `;

          // Build DOM safely — dynamic text via textContent (no innerHTML interpolation)
          const textWrap = document.createElement("div");
          const strongEl = document.createElement("strong");
          strongEl.style.cssText = "font-size:11px; text-transform:uppercase; letter-spacing:0.5px; opacity:0.8;";
          strongEl.textContent = "\ud83d\udce9 " + ttl;
          const msgSpan = document.createElement("span");
          msgSpan.style.cssText = "font-size:14px;";
          msgSpan.textContent = msg;
          textWrap.appendChild(strongEl);
          textWrap.appendChild(document.createElement("br"));
          textWrap.appendChild(msgSpan);

          const dismissBtn = document.createElement("button");
          dismissBtn.id = "kybergate-dismiss-msg";
          dismissBtn.style.cssText = "background:rgba(255,255,255,0.2); border:none; color:white; padding:6px 16px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:600;";
          dismissBtn.textContent = "Dismiss";

          banner.appendChild(textWrap);
          banner.appendChild(dismissBtn);

          // Add animation keyframes
          const style = document.createElement("style");
          style.textContent = `
            @keyframes kyberSlideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
          `;
          document.head.appendChild(style);
          document.body.appendChild(banner);

          document.getElementById("kybergate-dismiss-msg").addEventListener("click", () => {
            banner.remove();
            style.remove();
          });

          // Auto-dismiss after 30 seconds
          setTimeout(() => {
            if (banner.parentNode) banner.remove();
            if (style.parentNode) style.remove();
          }, 30000);
        },
        args: [message, title],
      });
    }
  } catch (e) {
    console.warn("Message banner injection failed:", e);
    // ⚠️ #421 — do NOT report a message as displayed when the injection threw.
    // The Chrome notification above may still have fired, but we cannot prove
    // the student saw anything, and this is the direction to be wrong in.
    return { status: "failed", error: `message banner injection failed: ${e?.message || e}` };
  }

  console.log(`💬 Teacher message displayed: ${message}`);
  // "message displayed" is the contract (proxy ackContracts["message"]).
  // ⚠️ The message TEXT is deliberately not echoed into the ack: it is
  // teacher-authored content bound for a jsonb column read by the fleet page,
  // and the outcome only needs to say that delivery happened.
  return { status: "completed", result: "message displayed to student" };
}

// ── Announcement Command (full-width banner, auto-dismiss) ──
async function handleAnnouncementCommand(cmd) {
  const message = cmd.message || cmd.payload?.message || "Announcement from your teacher";
  const teacherName = cmd.teacherName || cmd.payload?.teacherName || "Teacher";
  const duration = (cmd.duration || cmd.payload?.duration || 10) * 1000;

  // Inject announcement banner on ALL visible tabs
  const tabs = await chrome.tabs.query({});
  // #421: count the tabs we injected into, so the ack can name the effect.
  let injected = 0;
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
      injected++;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg, teacher, dur) => {
          const existing = document.getElementById("kybergate-announcement");
          if (existing) existing.remove();

          const banner = document.createElement("div");
          banner.id = "kybergate-announcement";
          banner.style.cssText = `
            position: fixed !important;
            top: 0 !important; left: 0 !important; right: 0 !important;
            background: #FAF9F6 !important;
            border-bottom: 3px solid #E07A5F !important;
            padding: 20px 32px !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            z-index: 2147483646 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            box-shadow: 0 6px 20px rgba(0,0,0,0.12) !important;
            animation: kyberAnnounceFade 0.4s ease-out !important;
          `;

          // Build DOM safely — dynamic text via textContent (no innerHTML interpolation)
          const contentWrap = document.createElement("div");
          contentWrap.style.cssText = "flex:1;";

          const headRow = document.createElement("div");
          headRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:6px;";
          const badge = document.createElement("span");
          badge.style.cssText = "background:#E07A5F; color:white; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; padding:3px 10px; border-radius:20px;";
          badge.textContent = "\ud83d\udce2 Announcement";
          const fromSpan = document.createElement("span");
          fromSpan.style.cssText = "font-size:11px; color:#9CA3AF;";
          fromSpan.textContent = "from " + teacher;
          headRow.appendChild(badge);
          headRow.appendChild(fromSpan);

          const msgP = document.createElement("p");
          msgP.style.cssText = "font-size:16px; font-weight:600; color:#1A1A2A; margin:0; line-height:1.4;";
          msgP.textContent = msg;

          contentWrap.appendChild(headRow);
          contentWrap.appendChild(msgP);

          const dismissBtn = document.createElement("button");
          dismissBtn.id = "kybergate-dismiss-announcement";
          dismissBtn.style.cssText = "background:#E07A5F; border:none; color:white; padding:8px 20px; border-radius:12px; cursor:pointer; font-size:12px; font-weight:600; white-space:nowrap; margin-left:16px;";
          dismissBtn.textContent = "Dismiss";

          banner.appendChild(contentWrap);
          banner.appendChild(dismissBtn);

          const style = document.createElement("style");
          style.id = "kybergate-announcement-style";
          style.textContent = `
            @keyframes kyberAnnounceFade {
              from { transform: translateY(-100%); opacity: 0; }
              to { transform: translateY(0); opacity: 1; }
            }
          `;
          document.head.appendChild(style);
          document.body.appendChild(banner);

          document.getElementById("kybergate-dismiss-announcement").addEventListener("click", () => {
            banner.style.animation = "kyberAnnounceFade 0.3s ease-in reverse";
            setTimeout(() => { banner.remove(); style.remove(); }, 300);
          });

          // Auto-dismiss
          setTimeout(() => {
            if (banner.parentNode) {
              banner.style.animation = "kyberAnnounceFade 0.3s ease-in reverse";
              setTimeout(() => { if (banner.parentNode) banner.remove(); if (style.parentNode) style.remove(); }, 300);
            }
          }, dur);
        },
        args: [message, teacherName, duration],
      }).catch(() => {});
    }
  }

  // Also show Chrome notification
  try {
    await chrome.notifications.create(`announcement-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `📢 Announcement from ${teacherName}`,
      message: message,
      priority: 2,
    });
  } catch (e) {
    console.warn("Announcement notification failed:", e);
    // ⚠️ If the Chrome notification failed AND no tab took a banner, nothing was
    // shown to the student. Reporting that as a success is the #29 mistake.
    if (injected === 0) {
      return { status: "failed", error: `announcement not displayed: ${e?.message || e}` };
    }
  }

  console.log(`📢 Announcement displayed: ${message}`);
  // "announcement displayed" is the contract (proxy ackContracts["announcement"]).
  return { status: "completed", result: `announcement displayed on ${injected} tab(s)` };
}

// ── Chat Notification (teacher sent a message via chat) ──
async function handleChatNotification(cmd) {
  const text = cmd.message || cmd.text || cmd.payload?.text || "";
  const senderName = cmd.teacherName || cmd.senderName || cmd.payload?.senderName || "Teacher";
  // #421: an empty chat body is a known refusal, not an unverifiable ack.
  if (!text) return { status: "failed", error: "chat command carried no message text" };

  // Show chat notification popup on active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith("chrome://")) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg, sender) => {
          const existing = document.getElementById("kybergate-chat-notif");
          if (existing) existing.remove();

          const notif = document.createElement("div");
          notif.id = "kybergate-chat-notif";
          notif.style.cssText = `
            position: fixed !important;
            bottom: 20px !important; right: 20px !important;
            width: 300px !important;
            background: white !important;
            border: 1px solid #E8E6E1 !important;
            border-radius: 16px !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.12) !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            z-index: 2147483645 !important;
            animation: kyberChatSlide 0.3s ease-out !important;
            overflow: hidden !important;
          `;

          // Build DOM safely — dynamic text via textContent (no innerHTML interpolation)
          const header = document.createElement("div");
          header.style.cssText = "padding:12px 16px; border-bottom:1px solid #F0EEEA; display:flex; align-items:center; justify-content:space-between;";

          const senderWrap = document.createElement("div");
          senderWrap.style.cssText = "display:flex; align-items:center; gap:8px;";
          const avatar = document.createElement("div");
          avatar.style.cssText = "width:28px; height:28px; border-radius:50%; background:#E07A5F; display:flex; align-items:center; justify-content:center; color:white; font-size:11px; font-weight:700;";
          avatar.textContent = sender && sender.length ? sender[0] : "?";
          const senderSpan = document.createElement("span");
          senderSpan.style.cssText = "font-size:12px; font-weight:600; color:#1A1A2A;";
          senderSpan.textContent = sender;
          senderWrap.appendChild(avatar);
          senderWrap.appendChild(senderSpan);

          const closeBtn = document.createElement("button");
          closeBtn.id = "kybergate-chat-notif-close";
          closeBtn.style.cssText = "background:none; border:none; cursor:pointer; color:#9CA3AF; font-size:16px; padding:4px;";
          closeBtn.textContent = "\u00d7";

          header.appendChild(senderWrap);
          header.appendChild(closeBtn);

          const body = document.createElement("div");
          body.style.cssText = "padding:12px 16px;";
          const msgP = document.createElement("p");
          msgP.style.cssText = "font-size:13px; color:#1A1A2A; margin:0; line-height:1.4;";
          msgP.textContent = msg;
          body.appendChild(msgP);

          notif.appendChild(header);
          notif.appendChild(body);

          const style = document.createElement("style");
          style.id = "kybergate-chat-notif-style";
          style.textContent = `
            @keyframes kyberChatSlide {
              from { transform: translateY(20px) scale(0.95); opacity: 0; }
              to { transform: translateY(0) scale(1); opacity: 1; }
            }
          `;
          document.head.appendChild(style);
          document.body.appendChild(notif);

          document.getElementById("kybergate-chat-notif-close").addEventListener("click", () => {
            notif.remove(); style.remove();
          });

          setTimeout(() => {
            if (notif.parentNode) notif.remove();
            if (style.parentNode) style.remove();
          }, 15000);
        },
        args: [text, senderName],
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("Chat notification failed:", e);
    return { status: "failed", error: `chat notification failed: ${e?.message || e}` };
  }

  console.log(`💬 Chat notification: ${senderName}: ${text}`);
  // "chat displayed" is the contract (proxy ackContracts["chat"]).
  // ⚠️ Neither the message text nor the sender is echoed into the ack — chat
  // content is not outcome data and must not land in device_commands.result.
  return { status: "completed", result: "chat notification displayed" };
}

// ── Command Polling Start/Stop ──
function startCommandPolling() {
  stopCommandPolling();
  console.log("🎓 Starting teacher command polling (every 3s)");
  pollTeacherCommands(); // immediate first poll
  commandPollInterval = setInterval(pollTeacherCommands, COMMAND_POLL_MS);
}

function stopCommandPolling() {
  if (commandPollInterval) {
    clearInterval(commandPollInterval);
    commandPollInterval = null;
    console.log("🎓 Stopped teacher command polling");
  }
}

// ── Chat Message Polling (during classroom sessions) ──
let chatPollInterval = null;
let lastChatTimestamp = null;

function startChatPolling() {
  stopChatPolling();
  lastChatTimestamp = new Date().toISOString();
  console.log("💬 Starting chat polling");
  chatPollInterval = setInterval(pollChatMessages, 5000);
}

function stopChatPolling() {
  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
    lastChatTimestamp = null;
    console.log("💬 Stopped chat polling");
  }
}

async function pollChatMessages() {
  if (!config.enrolled || !classroomSession) return;
  try {
    const chatRes = await api.getChatMessages(config.orgId, classroomSession.id);
    const messages = chatRes?.messages || [];
    if (!messages || messages.length === 0) return;

    // Filter to new messages since last poll
    const newMessages = messages.filter(m => {
      const ts = m.timestamp || "";
      if (!lastChatTimestamp) return false;
      if (ts <= lastChatTimestamp) return false;
      // Only show messages targeted at this device or broadcast (no targetDeviceId)
      if (m.targetDeviceId && m.targetDeviceId !== config.deviceId) return false;
      // Don't show own messages
      if (m.sender === "student" && m.deviceId === config.deviceId) return false;
      return true;
    }).sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

    for (const msg of newMessages) {
      // Trigger chat notification command handler
      await handleChatNotification({
        text: msg.text,
        senderName: msg.senderName || "Teacher",
      });
      if (msg.timestamp && msg.timestamp > (lastChatTimestamp || "")) {
        lastChatTimestamp = msg.timestamp;
      }
    }
  } catch (e) {
    console.error("Chat poll error:", e);
  }
}

// ============================================================
// Always poll commands when enrolled (even outside sessions)
// This ensures teachers can send lock/message commands anytime
// Chrome MV3 minimum alarm period is ~1 min; setInterval handles
// the fast 3-second polling while service worker is alive.
// The alarm is a fallback wake-up for when the worker sleeps.
// ============================================================

chrome.alarms.create("commandPoll", { periodInMinutes: 0.5 });

// Integrate command poll into the existing alarm system
// (handled by the separate listener below)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "commandPoll" && config.enrolled) {
    // Converge back to the 3s cadence from ANY wake path (#202). A bare
    // pollTeacherCommands() here left `commandPollInterval` null, so a device
    // whose worker had been evicted stayed on this 30s alarm indefinitely —
    // one poll is not recovery. Re-arm when the loop is dead; when it is
    // healthy, keep this tick a plain poll so the alarm can't re-issue an
    // immediate poll every 30s on top of a live 3s loop.
    if (!commandPollInterval) startCommandPolling();
    else await pollTeacherCommands();
  }
});
