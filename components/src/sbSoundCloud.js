/* *=BEGIN SONGBIRD GPL
 *
 * This file is part of the Songbird web player.
 *
 * Copyright(c) 2005-2011 POTI, Inc.
 * http://www.songbirdnest.com
 *
 * This file may be licensed under the terms of of the
 * GNU General Public License Version 2 (the ``GPL'').
 *
 * Software distributed under the License is distributed
 * on an ``AS IS'' basis, WITHOUT WARRANTY OF ANY KIND, either
 * express or implied. See the GPL for the specific language
 * governing rights and limitations.
 *
 * You should have received a copy of the GPL along with this
 * program. If not, go to http://www.gnu.org/licenses/gpl.html
 * or write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 *
 *=END SONGBIRD GPL
 */

/**
 * \file sbSoundCloud.js
 * \brief Service component for SoundCloud.
 */
const Cc = Components.classes;
const CC = Components.Constructor;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://app/jsmodules/DebugUtils.jsm");
Cu.import("resource://app/jsmodules/SBDataRemoteUtils.jsm");
Cu.import("resource://app/jsmodules/sbProperties.jsm");
Cu.import("resource://app/jsmodules/ServicePaneHelper.jsm");
Cu.import("resource://app/jsmodules/StringUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var Application = Cc["@mozilla.org/fuel/application;1"]
                    .getService(Ci.fuelIApplication);

const NS = 'http://songbirdnest.com/soundcloud#';
const SB_NS = 'http://songbirdnest.com/data/1.0#';
const SP_NS = 'http://songbirdnest.com/rdf/servicepane#';

// SoundCloud property constants
const SB_PROPERTY_USER = SB_NS + "user";
const SB_PROPERTY_PLAYS = SB_NS + "playcount";
const SB_PROPERTY_FAVS = SB_NS + "favcount";
const SB_PROPERTY_WAVEFORM = SB_NS + "waveformURL";
const SB_PROPERTY_DOWNLOAD_IMAGE = SB_NS + "downloadImage";
const SB_PROPERTY_DOWNLOAD_URL = SB_NS + "downloadURL";
const SB_PROPERTY_CREATION_DATE = SB_NS + "creationDate";

const SOCL_URL = 'https://api.soundcloud.com';
const AUTH_PAGE = 'chrome://soundcloud/content/soundcloudAuthorize.xul'
const CONSUMER_SECRET = "YqGENlIGpWPnjQDJ2XCLAur2La9cTLdMYcFfWVIsnvw";
const CONSUMER_KEY = "eJ2Mqrpr2P4TdO62XXJ3A";
const SIG_METHOD = "HMAC-SHA1";

const MAX_RETRIES = 5;

/*
 * SoundCloud library objects.
 */
var Libraries = {
  SEARCH: {
    "name": "SoundCloud",
    "guid": "main"
  },
  DOWNLOADS: {
    "name": "Downloads",
    "guid": "downloads"
  },
  DASHBOARD: {
    "name": "Dashboard",
    "guid": "dashboard"
  },
  FAVORITES: {
    "name": "Favorites",
    "guid": "favorites"
  }
}

/*
 * Manages SoundCloud login state.
 */
var Logins = {
  loginManager: Cc["@mozilla.org/login-manager;1"]
      .getService(Ci.nsILoginManager),

  LOGIN_HOSTNAME: 'http://soundcloud.com',
  LOGIN_FIELD_USERNAME: 'username',
  LOGIN_FIELD_PASSWORD: 'password',

  get: function() {
    // username & password
    var username = '';
    var password = '';
    // lets ask the login manager
    var logins = this.loginManager.findLogins({}, this.LOGIN_HOSTNAME,
                                              '', null);
    for (var i = 0; i < logins.length; i++) {
      if (i==0) {
        // use the first username & password we find
        username = logins[i].username;
        password = logins[i].password;
      } else {
        // get rid of the rest
        this.loginManager.removeLogin(logins[i]);
      }
    }
    return {username: username, password: password};
  },

  set: function(username, password) {
    var logins = this.loginManager.findLogins({}, this.LOGIN_HOSTNAME,
                                              '', null);
    for (var i=0; i<logins.length; i++) {
      this.loginManager.removeLogin(logins[i]);
    }
    // set new login info
    var nsLoginInfo = new CC("@mozilla.org/login-manager/loginInfo;1",
      Ci.nsILoginInfo, "init");
    this.loginManager.addLogin(new nsLoginInfo(this.LOGIN_HOSTNAME,
        '', null, username, password,
        this.LOGIN_FIELD_USERNAME, this.LOGIN_FIELD_PASSWORD));
  }
}

/*
 * SoundCloud listeners.
 */
function Listeners() {
  var listeners = [];
  this.add = function Listeners_add(aListener) {
    listeners.push(aListener);
  }
  this.remove = function Listeners_remove(aListener) {
    for(;;) {
      // find our listener in the array
      let i = listeners.indexOf(aListener);
      if (i >= 0) {
        // remove it
        listeners.splice(i, 1);
      } else {
        return;
      }
    }
  }
  this.each = function Listeners_each(aCallback) {
    for (var i=0; i<listeners.length; i++) {
      try {
        aCallback(listeners[i]);
      } catch(e) {
        Cu.reportError(e);
      }
    }
  }
}

function sbSoundCloudSearchService() {
  this.createTable =
    function sbSoundCloudSearchService_createTable() {
      if (!this._dbq)
        this._initQuery();

      this._dbq.addQuery("CREATE TABLE IF NOT EXISTS search_history"
                         + "(id INTEGER PRIMARY KEY,"
                         + "timestamp INTEGER, url TEXT,"
                         + "terms TEXT)");
      this._dbq.execute();
      this._dbq.resetQuery();
    }

  this.insertSearch =
    function sbSoundCloudSearchService_insertSearch(aUrl, aTerms) {
      if (!this._dbq)
        this._initQuery();

      this._dbq.addQuery("INSERT INTO search_history VALUES (NULL, "
                         + Date.now() + ", '" + aUrl + "', '" + aTerms
                         + "')");
      this._dbq.execute();
      this._dbq.resetQuery();
    }

  this.getLastSearch =
    function sbSoundCloudSearchService_getLastSearch() {
      if (!this._dbq)
        this._initQuery();

      this._dbq.addQuery("SELECT * FROM search_history "
                         + "ORDER BY id DESC LIMIT 1");
      this._dbq.execute();
      this._dbq.waitForCompletion();
      var rs = this._dbq.getResultObject();
      return rs.getRowCell(0, 3);
  }

  this._initQuery =
    function sbSoundCloudSearchService__initQuery() {
      try {
        var ios = Cc["@mozilla.org/network/io-service;1"]
                    .createInstance(Ci.nsIIOService);
        var dir = Cc["@mozilla.org/file/directory_service;1"]
                    .getService(Ci.nsIProperties)
                    .get("ProfD", Ci.nsIFile);
        dir.append("db");
        dir.append("soundcloud");
        var uri = ios.newFileURI(dir);
        this._dbq = Cc["@songbirdnest.com/Songbird/DatabaseQuery;1"]
                      .createInstance(Ci.sbIDatabaseQuery);
        this._dbq.databaseLocation = uri;
        this._dbq.setDatabaseGUID("search-history@soundcloud.com");
        this._dbq.setAsyncQuery(false);
        this._dbq.resetQuery();
      } catch(e) {
        Cu.reportError(e);
      }
    }
}

/*
 * Helper functions
 */
function urlencode(obj) {
  var params = '';

  for (let p in obj) {
    if (p == 0) {
      params += obj[p][0] + "=" + obj[p][1];
    } else {
      params += "&" + obj[p][0] + "=" + obj[p][1];
    }
  }

  return params;
}

function GET(url, params, onload, onerror, oauth) {
  var xhr = null;

  dump("\n\n" + url + "?" + params + "\n\n");
  try {
    xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
    xhr.mozBackgroundRequest = true;
    xhr.onload = function(event) { onload(xhr); }
    xhr.onerror = function(event) { onerror(xhr); }
    xhr.open('GET', url + "?" + params, true);
    if (oauth)
      xhr.setRequestHeader('Authorization', 'OAuth');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send();
  } catch(e) {
    Cu.reportError(e);
    onerror(xhr);
  }
  return xhr;
}

function POST(url, params, onload, onerror) {
  var xhr = null;

  try {
    xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
    xhr.mozBackgroundRequest = true;
    xhr.onload = function(event) { onload(xhr); }
    xhr.onerror = function(event) { onerror(xhr); }
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.setRequestHeader('Content-length', params.length);
    xhr.setRequestHeader('Connection', 'close');
    xhr.send(params);
  } catch(e) {
    Cu.reportError(e);
    onerror(xhr);
  }
  return xhr;
}

/**
 * SoundCloud XPCOM service component
 */
function sbSoundCloud() {
  // Imports
  Cu.import("resource://soundcloud/OAuth.jsm");

  this.wrappedJSObject = this;

  this.log = DebugUtils.generateLogFunction("sbSoundCloud");

  this.listeners = new Listeners();

  var login = Logins.get();
  this.username = login.username;
  this.password = login.password;

  this._searchService = new sbSoundCloudSearchService();
  this._searchService.createTable();

  this._prefs = Cc['@mozilla.org/preferences-service;1']
                  .getService(Ci.nsIPrefService)
                  .getBranch("extensions.soundcloud.");

  /**
   * \brief Gets (or creates) a SoundCloud library.
   *
   * \param aLibrary              SoundCloud Library object.
   * \param aUserId               User id. If passed, user-specific library
   *                              will be created.
   *
   * \return sbILibrary
   */
  this._getLibrary =
  function sbSoundCloud__getLibrary(aLibrary, aUserId) {
    var libraryManager = Cc["@songbirdnest.com/Songbird/library/Manager;1"]
                           .getService(Ci.sbILibraryManager);
    var library = {};
    var pref = aLibrary.guid + ".guid";
    var guid = (this._prefs.prefHasUserValue(pref)) ?
                 this._prefs.getCharPref(pref) : false;
    if (!guid) {
      var directory = Cc["@mozilla.org/file/directory_service;1"]
                        .getService(Ci.nsIProperties)
                        .get("ProfD", Ci.nsIFile);
      directory.append("db");
      directory.append("soundcloud");
      var file = directory.clone();
      // Create local (per user) or global (all users) db
      if (aUserId) {
        file.append(aLibrary.guid + "-" + aUserId + "@soundcloud.com.db");
      } else {
        file.append(aLibrary.guid + "@soundcloud.com.db");
      }
      var libraryFactory =
        Cc["@songbirdnest.com/Songbird/Library/LocalDatabase/LibraryFactory;1"]
          .getService(Ci.sbILibraryFactory);
      var bag = Cc["@mozilla.org/hash-property-bag;1"]
                  .createInstance(Ci.nsIWritablePropertyBag2);
      bag.setPropertyAsInterface("databaseFile", file);
      library = libraryFactory.createLibrary(bag);
    } else {
      library = libraryManager.getLibrary(guid);
      this._prefs.setCharPref(aLibrary.guid + ".guid", library.guid);
    }
    return library;
  }

  /**
   * \brief Adds media items to a SoundCloud library.
   *
   * \param aItems                JSON object of items to add.
   * \param aLibrary              Target library for added items.
   *
   */
  this._addItemsToLibrary =
  function sbSoundCloud__addItemsToLibrary(aItems, aLibrary) {
    var self = this;
    if (aItems != null) {
      var itemArray = Cc["@songbirdnest.com/moz/xpcom/threadsafe-array;1"]
                         .createInstance(Ci.nsIMutableArray);
      var propertiesArray = Cc["@songbirdnest.com/moz/xpcom/threadsafe-array;1"]
                              .createInstance(Ci.nsIMutableArray);
  
      for (let i = 0; i < aItems.length; i++) {
        var createdAt = new Date(aItems[i].created_at).getTime();
        var title = aItems[i].title;
        var duration = aItems[i].duration * 1000;
        var artwork = aItems[i].artwork_url;
        var username = aItems[i].user.username;
        var playcount = aItems[i].playback_count;
        var favcount = aItems[i].favoritings_count;
        var uri = aItems[i].uri;
        var waveformURL = aItems[i].waveform_url;
        var downloadURL = aItems[i].download_url || "";
        var streamURL = aItems[i].stream_url;
  
        if (downloadURL.indexOf(SOCL_URL) != -1)
          downloadURL += "?consumer_key=" + CONSUMER_KEY;
  
        if (!streamURL || streamURL.indexOf(SOCL_URL) == -1)
          continue;
        streamURL += "?consumer_key=" + CONSUMER_KEY;
  
        var properties =
          Cc["@songbirdnest.com/Songbird/Properties/MutablePropertyArray;1"]
            .createInstance(Ci.sbIMutablePropertyArray);
  
        properties.appendProperty(SB_PROPERTY_CREATION_DATE, createdAt);
        properties.appendProperty(SBProperties.trackName, title);
        properties.appendProperty(SBProperties.duration, duration);
        properties.appendProperty(SBProperties.primaryImageURL, artwork);
        properties.appendProperty(SB_PROPERTY_USER, username);
        properties.appendProperty(SB_PROPERTY_PLAYS, playcount);
        properties.appendProperty(SB_PROPERTY_FAVS, favcount);
        properties.appendProperty(SB_PROPERTY_WAVEFORM, waveformURL);
        if (downloadURL) {
          properties.appendProperty(SB_PROPERTY_DOWNLOAD_IMAGE,
                                    "chrome://soundcloud/skin/download.png");
          properties.appendProperty(SB_PROPERTY_DOWNLOAD_URL, downloadURL);
        }
 
        var ios = Cc["@mozilla.org/network/io-service;1"]
                    .getService(Ci.nsIIOService);
        
        itemArray.appendElement(ios.newURI(streamURL, null, null), false);
        propertiesArray.appendElement(properties, false);
      }
  
      var batchListener = {
        onProgress: function(aIndex) {},
        onComplete: function(aMediaItems, aResult) {
          self.listeners.each(function(l) { l.onItemsAdded(); });
        }
      };
  
      aLibrary.batchCreateMediaItemsAsync(batchListener,
                                          itemArray,
                                          propertiesArray,
                                          false);
    }
  }
  
  /**
   * \brief Creates an HMAC-SHA1 signature for an OAuth request.
   *
   * \param aMessage              Message to sign.
   *
   * \return HMAC-SHA1 signature string
   */
  this._sign = function sbSoundCloud__sign(aMessage) {
    var baseString = this._getBaseString(aMessage);
    var signature = b64_hmac_sha1(encodeURIComponent(CONSUMER_SECRET)
                                  + "&" 
                                  + encodeURIComponent(this._token_secret),
                                  baseString);
    return signature;
  }

  /**
   * \brief Retrieves a base string.
   *
   * \param aMessage              Message to encode.
   *
   * \return Encoded base string
   */
  this._getBaseString =
  function sbSoundCloud__getBaseString(aMessage) {
    var params = aMessage.parameters;
    var s = "";
    for (let p in params) {
      if (params[p][0] != 'oauth_signature') {
        if (p == 0) {
          s = params[p][0] + "=" + params[p][1];
        } else {
          s += "&" + params[p][0] + "=" + params[p][1];
        }
      }
    }
    return aMessage.method + '&' + encodeURIComponent(aMessage.action)
                          + '&' + encodeURIComponent(s);
  }

  /**
   * \brief Creates parameters for an OAuth request.
   *
   * \param aURL                  Request URL.
   * \param aMethodType           Request method.
   *
   * \return URL encoded string of parameters
   */
  this._getParameters =
  function sbSoundCloud__getParameters(aURL, aMethodType) {
    var accessor = { consumerSecret: CONSUMER_SECRET };
    var message = { action: aURL,
                    method: aMethodType,
                    parameters: []
                  };

    message.parameters.push(['oauth_consumer_key', CONSUMER_KEY]);
    message.parameters.push(['oauth_nonce', OAuth.nonce(11)]);
    message.parameters.push(['oauth_signature_method', SIG_METHOD]);
    message.parameters.push(['oauth_timestamp', OAuth.timestamp()]);
    if (this._oauth_token)
      message.parameters.push(['oauth_token', this._oauth_token]);
    message.parameters.push(['oauth_version', "1.0"]);

    message.parameters.push(['oauth_signature', this._sign(message)]);

    return urlencode(message.parameters);
  }

  /**
   * \brief Requests OAuth token.
   *
   * \param aSuccess              Action to take on success.
   * \param aFailure              Action to take on failure.
   *
   */
  this._requestToken =
  function sbSoundCloud__requestToken(aSuccess, aFailure) {
    var self = this;

    this._oauth_token = "";
    this._token_secret = "";

    var url = SOCL_URL + "/oauth/request_token";
    var params = this._getParameters(url, 'POST');

    if (!this._oauth_retries)
      this._oauth_retries = 0;

    var reqTokenSuccess = function reqTokenSuccess(xhr) {
      let response = xhr.responseText;
      if (response == "Invalid OAuth Request") {
        if (self._oauth_retries < MAX_RETRIES) {
          dump("\nOAuth request token #" + ++self._oauth_retries);
          self._requestToken(aSuccess, aFailure);
        } else {
          self._oauth_retries = null;
          aFailure(xhr);
        }
      } else {
        let tokenized = response.split("&")
        self._oauth_token = tokenized[0].split("=")[1];
        self._token_secret = tokenized[1].split("=")[1];

        self._prefs.setCharPref(self.username + ".oauth_token",
                                self._oauth_token);
        self._oauth_retries = null;

        aSuccess();
      }
    }

    var reqTokenFailure = function reqTokenFailure(xhr) {
      self._oauth_retries = null;
      aFailure(xhr);
      dump("\nStatus: " + xhr.status + "\n" + xhr.getAllResponseHeaders());
    }

    this._reqtoken_xhr = POST(url,
                              params,
                              reqTokenSuccess,
                              reqTokenFailure);
    return this._reqtoken_xhr;
  }

  /**
   * \brief Opens SoundCloud authorization dialog.
   *
   */
  this._authorize =
  function sbSoundCloud__authorize() {
    Logins.set(this.username, this.password);

    var mainWindow = Cc["@mozilla.org/appshell/window-mediator;1"]
                       .getService(Ci.nsIWindowMediator)
                       .getMostRecentWindow('Songbird:Main');
    var features = "modal=yes,dependent=yes,resizable=yes,titlebar=no";
    mainWindow.openDialog(AUTH_PAGE,
                          "soundcloud_authorize", features);
  }

  /**
   * \brief Requests OAuth access token.
   *
   * \param aSuccess              Action to take on success.
   * \param aFailure              Action to take on failure.
   *
   */
  this._accessToken =
  function sbSoundCloud__accessToken(aSuccess, aFailure) {
    var self = this;

    var url = SOCL_URL + "/oauth/access_token";
    var params = self._getParameters(url, 'POST');

    if (!this._oauth_retries)
      this._oauth_retries = 0;

    var accessTokenSuccess = function accessTokenSuccess(xhr) {
      let response = xhr.responseText;
      if (response == "Invalid OAuth Request") {
        if (self._oauth_retries < MAX_RETRIES) {
          dump("\nOAuth access token #" + ++self._oauth_retries);
          self._accessToken(aSuccess, aFailure);
        } else {
          self._oauth_retries = null;
          aFailure(xhr);
        }
      } else {
        let tokenized = response.split("&")

        self._oauth_token = tokenized[0].split("=")[1];
        self._token_secret = tokenized[1].split("=")[1];
        aSuccess(xhr);

        self._oauth_retries = null;

        self.updateProfile();
      }
    }

    var accessTokenFailure = function accessTokenFailure(xhr) {
      self._oauth_retries = null;
      aFailure(xhr);
      dump("\nStatus: " + xhr.status + "\n" + xhr.getAllResponseHeaders());
    }

    this._accesstoken_xhr = POST(url,
                                 params,
                                 accessTokenSuccess,
                                 accessTokenFailure);
    return this._accesstoken_xhr;
  }

  this._nowplaying_url = null;
  this.__defineGetter__('nowplaying_url', function() {
    return this._nowplaying_url;
  });
  this.__defineSetter__('nowplaying_url', function(val) {
    this._nowplaying_url = val;
  });

  this.__defineGetter__('soundcloud_url', function() {
    return SOCL_URL;
  });

  this.__defineGetter__('oauth_token', function() {
    let pref = this.username + ".oauth_token";
    this._oauth_token = (this._prefs.prefHasUserValue(pref)) ?
                         this._prefs.getCharPref(pref) : null;
    return this._oauth_token;
  });

  this.__defineGetter__('autoLogin', function() {
    let autologin = (this._prefs.prefHasUserValue('autologin')) ?
                      this._prefs.getBoolPref('autologin') : false;
    return autologin;
  });
  this.__defineSetter__('autoLogin', function(val) {
    this._prefs.setBoolPref('autologin', val);
    this.listeners.each(function(l) { l.onAutoLoginChanged(val); });
  });

  // user-logged-out pref
  this.__defineGetter__('userLoggedOut', function() {
    return this._prefs.getBoolPref('loggedOut');
  });
  this.__defineSetter__('userLoggedOut', function(val) {
    this._prefs.setBoolPref('loggedOut', val);
  });

  this._authorized = false;
  this.__defineGetter__('authorized', function() { return this._authorized; });
  this.__defineSetter__('authorized', function(aAuthorized){
    this._authorized = aAuthorized;
  });

  // the loggedIn state
  this._loggedIn = false;
  this.__defineGetter__('loggedIn', function() { return this._loggedIn; });
  this.__defineSetter__('loggedIn', function(aLoggedIn){
    this._loggedIn = aLoggedIn;
    this.listeners.each(function(l) { l.onLoggedInStateChanged(); });
  });

  // get the playback history service
  this._playbackHistory =
      Cc['@songbirdnest.com/Songbird/PlaybackHistoryService;1']
        .getService(Ci.sbIPlaybackHistoryService);
  // add ourselves as a playlist history listener
  this._playbackHistory.addListener(this);

  this._library = this._getLibrary(Libraries.SEARCH, null);
  this._downloads = this._getLibrary(Libraries.DOWNLOADS, null);

  this.__defineGetter__('library', function() { return this._library; });
  this.__defineGetter__('dashboard', function() {
    let dashLib = (this._dashboard) ? this._dashboard : null;
    return dashLib;
  });
  this.__defineGetter__('favorites', function() {
    let favLib = (this._favorites) ? this._favorites : null;
    return favLib;
  });
  this.__defineGetter__('downloads', function() { return this._downloads; });

  this.__defineGetter__('lastSearch', function() {
      if (!this._searchService)
        return;

      let term = "";

      try {
        term = this._searchService.getLastSearch();
      } catch(ex) {
        Cu.reportError(ex);
      }

      return term;
    });

  this._strings =
    Cc["@mozilla.org/intl/stringbundle;1"]
      .getService(Ci.nsIStringBundleService)
      .createBundle("chrome://soundcloud/locale/overlay.properties");

  this._servicePaneService = Cc['@songbirdnest.com/servicepane/service;1']
                               .getService(Ci.sbIServicePaneService);

  // find a radio folder if it already exists
  var radioFolder = this._servicePaneService.getNode("SB:RadioStations");
  if (!radioFolder) {
    radioFolder = this._servicePaneService.createNode();
    radioFolder.id = "SB:RadioStations";
    radioFolder.className = "folder radio";
    radioFolder.name = this._strings.GetStringFromName("radio.label");
    radioFolder.setAttributeNS(SB_NS, "radioFolder", 1); // for backward-compat
    radioFolder.setAttributeNS(SP_NS, "Weight", 2);
    this._servicePaneService.root.appendChild(radioFolder);
  }
  radioFolder.editable = false;

  var soclRadio = this._servicePaneService.getNode("SB:RadioStations:SoundCloud");
  if (!soclRadio) {
    this._servicePaneNode = this._servicePaneService.createNode();
    this._servicePaneNode.url =
      "chrome://soundcloud/content/directory.xul?type=main";
    this._servicePaneNode.id = "SB:RadioStations:SoundCloud";
    this._servicePaneNode.name = "SoundCloud";
    this._servicePaneNode.image = 'chrome://soundcloud/skin/favicon.png';
    this._servicePaneNode.editable = false;
    this._servicePaneNode.hidden = false;
    radioFolder.appendChild(this._servicePaneNode);
  }

  this._retry_count = 0;
}

// XPCOM Voodoo
sbSoundCloud.prototype.classDescription = 'Songbird SoundCloud Service';
sbSoundCloud.prototype.contractID = '@songbirdnest.com/soundcloud;1';
sbSoundCloud.prototype.classID =
    Components.ID('{dfa0469c-1dd1-11b2-a34d-aea86aafaf52}');
sbSoundCloud.prototype.QueryInterface =
    XPCOMUtils.generateQI([Ci.sbISoundCloudService]);

sbSoundCloud.prototype.updateServicePaneNodes =
function sbSoundCloud_updateServicePaneNodes() {
  var soclNode = this._servicePaneService
                     .getNode("SB:RadioStations:SoundCloud");
  if (this.loggedIn) {
    // Create following node
    // Need to do an async call to add children
    /*
    var followingNode = this._servicePaneService
                            .getNode("urn:soclfollowing");
    if (!followingNode) {
      followingNode = this._servicePaneService.createNode();
      followingNode.url=
        "chrome://soundcloud/content/directory.xul?type=following";
      followingNode.id = "urn:soclfollowing"
      followingNode.name = "Following";
      followingNode.tooltip = "People you follow";
      followingNode.editable = false;
      followingNode.setAttributeNS(SP_NS, "Weight", 10);
      soclNode.appendChild(followingNode);
      followingNode.hidden = false;
    }

    var followingBadge = ServicePaneHelper.getBadge(followingNode,
                                                    "soclfollowingcount");
    followingBadge.label = this.followingCount;
    followingBadge.visible = true;
    */

    // Create dashboard node
    var dashNode = this._servicePaneService
                      .getNode("urn:soclfavorites");
    if (!dashNode) {
      dashNode = this._servicePaneService.createNode();
      dashNode.url=
        "chrome://soundcloud/content/directory.xul?type=dashboard";
      dashNode.id = "urn:socldashboard"
      dashNode.name = "Dashboard";
      dashNode.tooltip = "Your dashboard";
      dashNode.editable = false;
      dashNode.setAttributeNS(SP_NS, "Weight", 5);
      soclNode.appendChild(dashNode);
      dashNode.hidden = true;
    }

    //var dashBadge = ServicePaneHelper.getBadge(dashNode, "socldashboard");
    //dashBadge.label = this.incomingCount;
    //dashBadge.visible = true;
 
    // Create favorites node
    var favNode = this._servicePaneService
                      .getNode("urn:soclfavorites");
    if (!favNode) {
      favNode = this._servicePaneService.createNode();
      favNode.url=
        "chrome://soundcloud/content/directory.xul?type=favorites";
      favNode.id = "urn:soclfavorites"
      favNode.name = "Favorites";
      favNode.image = "chrome://soundcloud/skin/favorites.png";
      favNode.tooltip = "Tracks you loved";
      favNode.editable = false;
      favNode.setAttributeNS(SP_NS, "Weight", 20);
      soclNode.appendChild(favNode);
      favNode.hidden = false;
    }

    var favBadge = ServicePaneHelper.getBadge(favNode, "soclfavcount");
    favBadge.label = this.favCount;
    favBadge.visible = true;
 
    this._dashboard = this._getLibrary(Libraries.DASHBOARD, null);
    this._favorites = this._getLibrary(Libraries.FAVORITES, this.userid);
  } else {
    while (soclNode.firstChild) {
      soclNode.removeChild(soclNode.firstChild);
    }
  }

  // XXX - Need to switch the active node if it's any of the above
}

sbSoundCloud.prototype.shouldAutoLogin =
function sbSoundCloud_shouldAutoLogin() {
  return this.autoLogin &&
         this.username &&
         this.password &&
         !this.userLoggedOut;
}

sbSoundCloud.prototype.login =
function sbSoundCloud_login(aClearSession) {
  var self = this;

  this.listeners.each(function(l) { l.onLoginBegins(); });

  this.userLoggedOut = false;

  var secretPref = this.username + ".token_secret";
  this._token_secret = (this._prefs.prefHasUserValue(secretPref)) ?
                        this._prefs.getCharPref(secretPref) : null;

  if ((this.oauth_token && this._token_secret) &&
      !aClearSession) {
    this.updateProfile();
    return;
  }
 
  var success = function success(xhr) {
    self._authorize();
  }

  var failure = function failure(xhr) {
    dump("\nRequest token failed: " + xhr.responseText);
  }

  this._requestToken(success, failure);
}

sbSoundCloud.prototype.logout =
function sbSoundCloud_logout() {
  this.userLoggedOut = true;
  this.loggedIn = false;
  this.updateServicePaneNodes();
}

sbSoundCloud.prototype.cancelLogin =
function sbSoundCloud_cancelLogin() {
  this.logout();
}

sbSoundCloud.prototype.authCallback =
function sbSoundCloud_authCallback() {
  var self = this;
  if (this.authorized) {
    var success = function success(xhr) {
      self._prefs.setCharPref(self.username + ".oauth_token",
                              self._oauth_token);
      self._prefs.setCharPref(self.username + ".token_secret",
                              self._token_secret);
    }

    var failure = function failure(xhr) {
      dump("\nAccess token failed; " + xhr.responseText);
    }

    this._accessToken(success, failure);
  } else {
    this.listeners.each(function(l) { l.onLoggedInStateChanged(); });
  }
}

sbSoundCloud.prototype.updateProfile =
function sbSoundCloud_updateProfile() {
  var self = this;

  if (!this._info_retries)
    this._info_retries = 0;

  var url = SOCL_URL + "/me.json";
  var params = this._getParameters(url, 'GET');

  var success = function(xhr) {
    let json = xhr.responseText;
    let jsObject = JSON.parse(json);
    if (jsObject.error) {
      if (self._info_retries < MAX_RETRIES) {
        dump("\nProfile Request #" + ++self._info_retries);
        self.updateProfile();
      } else {
        failure(xhr);
      }
    } else {
      self._info_retries = null;

      self.userid = jsObject.id;
      self.realname = jsObject.username;
      self.avatar = jsObject.avatar_url;
      self.followingCount = jsObject.followings_count;
      self.favCount = jsObject.public_favorites_count;
      self.city = jsObject.city;
      self.country = jsObject.country;
      self.profileurl = jsObject.permalink_url;

      self.listeners.each(function(l) { l.onProfileUpdated(); });

      self.loggedIn = true;
      self.updateServicePaneNodes();
    }
  }

  var failure = function(xhr) {
    dump("\nUnable to retrieve profile. Falling back to logged out state.");
    dump("\nStatus is " + xhr.status + "\n" + xhr.getAllResponseHeaders());
    self._info_retries = null;
    self.loggedIn = false;
    return false;
  }

  this._info_xhr = GET(url, params, success, failure, true);
}

sbSoundCloud.prototype.getFavorites =
function sbSoundCloud_getFavorites() {
  var self = this;
  if (!this.loggedIn)
    return;

  if (!this._fav_retries)
    this._fav_retries = 0;

  var url = SOCL_URL + "/me/favorites.json";
  var success = function(xhr) {
    let json = xhr.responseText;
    let favorites = JSON.parse(json);
    if (favorites.error) {
      if (self._fav_retries < MAX_RETRIES) {
        self._fav_retries++;
        self.getFavorites();
      } else {
        Cu.reportError("Unable to retrieve favorites: " + favorites.error);
        return false;
      }
    }

    self.favCount = favorites.length;
    self._addItemsToLibrary(favorites, self._favorites);
  }

  var failure = function(xhr) {
    dump("\nUnable to retrieve favorites.");
    dump("\nStatus is " + xhr.status + "\n" + xhr.getAllResponseHeaders());
    self._fav_retries = null;
    return false;
  }

  var params = this._getParameters(url, "GET");
  this._fav_xhr = GET(url, params, success, failure, true);
}

sbSoundCloud.prototype.getTracks =
function sbSoundCloud_getTracks(aQuery, aFlags, aOffset) {
  var self = this;

  if (!this.loggedIn)
    return;

  if (aOffset == 0) {
    if (this._track_xhr)
      this._track_xhr.abort();

    this._searchService.insertSearch(url + "?" + aFlags, aQuery);
  }

  if (!this._track_retries)
    this._track_retries = 0;

  var url = SOCL_URL + "/tracks.json";
  var success = function(xhr) {
    let json = xhr.responseText;
    let tracks = JSON.parse(json);
    if (tracks.error) {
      if (self._track_retries < MAX_RETRIES) {
        self._track_retries++;
        self.getTracks(aQuery, aFlags, aOffset);
      } else {
        Cu.reportError("Unable to retrieve tracks: " + tracks.error);
        self._track_retries = null;
        return false;
      }
    }

    if (tracks.length > 40) {
      self._track_retries = null;
      aOffset += tracks.length
      self._addItemsToLibrary(tracks, self._library);
      self._track_xhr = self.getTracks(aQuery, aFlags, aOffset);
    }
  }

  var failure = function(xhr) {
    dump("\nUnable to retrieve tracks.");
    dump("\nStatus is " + xhr.status + "\n" + xhr.getAllResponseHeaders());
    self._track_retries = null;
    return false;
  }

  var params = "q=" + aQuery + aFlags + "&offset=" + aOffset;
  params += "&consumer_key=" + CONSUMER_KEY;
  this._track_xhr = GET(url, params, success, failure, false);
}

sbSoundCloud.prototype.addListener =
function sbSoundCloud_addListener(aListener) {
  this._listeners.push(aListener);
}

sbSoundCloud.prototype.removeListener =
function sbSoundCloud_removeListener(aListener) {
  // find our listener in the array
  var i = this._listeners.indexOf(aListener);
  if (i >= 0) {
    this._listeners.splice(i, 1);
  }
}

sbSoundCloud.prototype.notifyListeners =
function sbSoundCloud_notifyListeners(aEventTrigger) {
  for (var i=0; i < this._listeners.length; i++) {
    var listener = this._listeners[i];
    if (listener instanceof Ci.sbISoundCloudListener) {
      try {
        listener[aEventTrigger]();
      } catch(e) {
        Cu.reportError("Could not signal " + aEventTrigger +
        " to sbSoundCloudListener. Failed with error: " + e.description);
      }
    }
  }
}

sbSoundCloud.prototype.shutdown = function sbSoundCloud_shutdown() {

}

var components = [sbSoundCloud];
function NSGetModule(compMgr, fileSpec) {
  return XPCOMUtils.generateModule(components);
}
