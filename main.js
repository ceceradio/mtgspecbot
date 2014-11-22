// Count all of the links 
var config = require('./config.js');
var jsdom = require("jsdom");
var request = require("request");
var tutor = require("tutor");
var mtgapi = require("./mtgapi");
mtgapi.setToken(config.mtgApiKey);
var mysql = require("mysql");
var connection = mysql.createConnection(config.mysql);

var tutorThrottle = 0;

/**
 * http://stackoverflow.com/questions/5129624/convert-js-date-time-to-mysql-datetime
 **/
function twoDigits(d) {
    if(0 <= d && d < 10) return "0" + d.toString();
    if(-10 < d && d < 0) return "-0" + (-1*d).toString();
    return d.toString();
}
Date.prototype.toMysqlFormat = function() {
    return this.getUTCFullYear() + "-" + twoDigits(this.getUTCMonth()) + "-" + twoDigits(this.getUTCDate()) + " " + twoDigits(this.getUTCHours()) + ":" + twoDigits(this.getUTCMinutes()) + ":" + twoDigits(this.getUTCSeconds());
};


connection.connect();
jsdom.env(
	"https://www.wizards.com/Magic/Digital/MagicOnlineTourn.aspx?x=mtg/digital/magiconline/tourn/6710666",
	["http://code.jquery.com/jquery.js"],
	function (errors, window) {
		console.log("there were ", window.$(".deck").length, " decks!");
		var deckLinks = new Array();
		window.$(".deck").each(function(i,val) {
			deckLinks.push(window.$(val).find(".dekoptions a").attr('href'));
		});
		var event = new Object;
		//get type
		event.type = window.$(".article-content .body h3").text();
		//find mtgo id
		var MtgoId_pattern = new RegExp("[0-9]+");
		event.vendor_id = MtgoId_pattern.exec(window.$(".article-content .body p").first().text())[0];
		//get date
		var MtgoDate_pattern = new RegExp("[0-9]+/[0-9]+/[0-9]+");
		event.date = MtgoDate_pattern.exec(window.$(".article-content .body p").first().text())[0];
		var dateSplit = event.date.split("/");
		event.date = new Date(dateSplit[2],dateSplit[0],dateSplit[1]).toMysqlFormat();
		//save the event and start parsing
		connection.query('INSERT INTO events SET ?', {type: event.type,date: event.date, vendor_id: event.vendor_id, params: JSON.stringify(event)}, function(err,result) {
			if (err) throw err;
			var eventId = result.insertId;
			
			var textDump = "";
			var continueLock = 0;
			for (var idx in deckLinks) {
				//console.log("https://www.wizards.com/"+deckLinks[idx]);
				continueLock++;
				request("https://www.wizards.com"+deckLinks[idx], function(error, response, body) {
					textDump += body;
					continueLock--;
					if (continueLock==0) {
						// Continue with parsing the text dump
						processDeckDump(textDump, eventId);
					}
				});
			}
		});
		//console.log(JSON.stringify(deckLinks));
	}
);
function processDeckDump(dump, eventId) {
	var rawCards = dump.split("\r\n");
	var cardLine;
	var lineArray;
	var cardDictionary = new Object;
	for (var i in rawCards) {
		cardLine = rawCards[i];
		if (cardLine.trim()=="")
			continue;
		lineArray = cardLine.split(" ");
		cardName = cardLine.substr(lineArray[0].length+1);
		if (cardName in cardDictionary) {
			cardDictionary[cardName] += parseInt(lineArray[0]);
		}
		else {
			cardDictionary[cardName] = parseInt(lineArray[0]);
		}
	}
	//store the dump
	storeDictionary(cardDictionary, eventId);
	//console.log(JSON.stringify(cardDictionary));
}
function storeDictionary(cardDictionary, eventId) {
	var insertArray = new Array();
	for (var cardName in cardDictionary) {
		var insertRow = [eventId, cardName, cardDictionary[cardName]];
		insertArray.push(insertRow);
	}
	console.log(insertArray);
	connection.query('INSERT INTO event_card_map (event_id, card_name, quantity) VALUES ?', [insertArray], function(err,result) {
		if (err) throw err;
		
		findNewCards(cardDictionary,eventId);
	});
	
}
function findNewCards(cardDictionary,excludeEventId) {
	connection.query('SELECT * FROM events WHERE id = ?', [excludeEventId], function(err,rows,fields) {
		if (err) throw err;
		
		connection.query('SELECT * FROM events WHERE type = ? AND id != ? ORDER BY date DESC LIMIT 1', [rows[0].type,excludeEventId], function(err,rows,fields) {
			if (err) throw err;
			if (rows.length>0)
				var includeEventId = rows[0].id;
			else 
				var includeEventId = excludeEventId;
			connection.query('SELECT * FROM event_card_map WHERE event_id = ? GROUP BY card_name', [includeEventId], function(err,rows,fields) {
				if (err) throw err;
				
				var previousCards = convertMysqlToJson(rows);
				var diffDictionary = new Object;
				for (var cardName in cardDictionary) {
					if (cardName in previousCards) {
						diffDictionary[cardName] = parseInt(cardDictionary[cardName]) - parseInt(previousCards[cardName]);
					}
					else {
						diffDictionary[cardName] = cardDictionary[cardName];
					}
				}
				startPriceReport(diffDictionary);
			});
		});
	});
	//connection.end();
}
function convertMysqlToJson(rows) {
	var cardDictionary = new Object;
	for (var i in rows) {
		cardRow = rows[i];
		if (cardName in cardDictionary) {
			cardDictionary[cardRow.card_name] += parseInt(cardRow.quantity);
		}
		else {
			cardDictionary[cardRow.card_name] = parseInt(cardRow.quantity);
		}
	}
	return cardDictionary;
}
function avoidSet(setName) {
	if (setName.indexOf("Premium") != -1)
		return true;
	if (setName.indexOf("From the Vault") != -1)
		return true;
	if (setName.indexOf("Masters Edition IV") != -1)
		return true;
	if (setName == "Archenemy")
		return true;
	return false;
}
function transformSet(setName) {
	if (setName=='Time Spiral "Timeshifted"') {
		return "Timeshifted";
	}
	if (setName=='Magic: The Gathering-Commander') {
		return "Commander";
	}
	return setName;
}
function recursiveSetSearch(tryNumber,cardName,callback) {
	if (tryNumber>5) {
		callback("404",cardName,"");
	}
	else {
		/*
		mtgapi.searchByName(cardName,function(err,card) {
			if (err) {
				recursiveSetSearch(tryNumber+1,cardName,callback);
			}
			else {
				callback(err,cardName,card.set);
			}
		});*/
		tutor.card(cardName.split("/")[0],function(err,card) {
			if (err) {
				recursiveSetSearch(tryNumber+1,cardName,callback);
			}
			else {
				var maxId = '0';
				for (var id in card.versions) {
					if (parseInt(id) > parseInt(maxId) && !avoidSet(card.versions[id].expansion)) {
						maxId = id;
					}
				}
				callback(err,cardName,transformSet(card.versions[maxId].expansion));
			}
		});
	}
}
function getCardSet(cardName,callback) {
	connection.query('SELECT * FROM price_cache WHERE card_name = ? ', [cardName], function(err,rows,fields) {
		if (err) throw err;
		
		if (rows.length>0) {
			console.log("Found",cardName);
			callback(err,cardName,rows[0].set_name);
		}
		else {
			//tutorThrottle+=1000;
			setTimeout(function() {
				console.log(cardName);
				recursiveSetSearch(0,cardName,callback);
			},tutorThrottle+(Math.random()*1000));
		}
	});
}
/*
callback(err,priceData)
priceData: Object
	paperCents
	onlineCents
	-1 = could not find
*/
function getCardPrice(cardName,setName,callback) {
	var dateTime = new Date();
	var currentDateTime = new Date().toMysqlFormat();
	dateTime.setHours(0);
	dateTime = dateTime.toMysqlFormat();
	var priceData = new Object;
	connection.query('SELECT * FROM price_cache WHERE card_name = ? AND set_name = ? AND cache_time >= ? ', [cardName,setName,dateTime], function(err,rows,fields) {
		if (err) throw err;
		if (typeof setName == undefined || undefined == setName || setName=="") {
			priceData.paperCents = -1;
			priceData.onlineCents = -1;
			console.log("Set lookup failed",cardName);
			callback(err,priceData);
			return;
		}
		
		var setNameURL = setName.replace("'","").replace(/[\s\W]+/gi,"+");
		var cardNameURL = cardName.replace("'","").replace("-","ZXCV").replace(/[\s\W]+/gi,"+").replace("ZXCV","-")
		var url = "http://www.mtggoldfish.com/price/"+setNameURL+"/"+cardNameURL;
		//console.log(url);
		if (rows.length==0) {
			jsdom.env(
			url,
			["http://code.jquery.com/jquery.js"],
			function (errors, window) {
				//if (errors) throw errors;
				if (errors) {
					priceData.paperCents = -1;
					priceData.onlineCents = -1;
				}
				else {
					if (window.$(".no-card").length > 0) {
						priceData.paperCents = -1;
						priceData.onlineCents = -1;
					}
					else {
						if (window.$("a.paper-price").length>0)
							priceData.paperCents = parseFloat(window.$("a.paper-price").text()) * 100;
						else
							priceData.paperCents = -1;
						if (window.$("a.online-price").length>0)
							priceData.onlineCents = parseFloat(window.$("a.online-price").text()) * 100;
						else
							priceData.onlineCents = -1;
					}
				}
				//save the data in the cache
				connection.query('INSERT INTO price_cache (card_name, set_name, cents_paper, cents_online, cache_time, url) VALUES ?', [[[cardName,setName,priceData.paperCents,priceData.onlineCents,currentDateTime, url]]], function(err,result) {
					if (err) throw err;
					
					callback(err,priceData);
				});
			});
		}
		else {
			priceData.paperCents = rows[0].cents_paper;
			priceData.onlineCents = rows[0].cents_online;
			
			callback(err,priceData);
		}
	});
	
}
function delayedCardPrice(cardDictionary,cardName,scheduledTime,callback) {
	setTimeout(
		function() {
			getCardSet(cardName,function(err,cardName,setName) {
				if (err) {
					var priceData = new Object;
					priceData.paperCents = -1;
					priceData.onlineCents = -1;
					
					callback("",cardName,priceData);
				}
				cardDictionary[cardName].setName = setName;
				//console.log(cardName,setName);
				if (setName != "") {
					getCardPrice(cardName,setName,function(err,priceData) {
						if (err) throw err;
						
						callback(err,cardName,priceData);
					});
				}
				else {
					var priceData = new Object;
					priceData.paperCents = -1;
					priceData.onlineCents = -1;
					
					callback(err,cardName,priceData);
				}
			});
		},scheduledTime);
}
function startPriceReport(cardDictionary) {
	var lockCount = Object.keys(cardDictionary).length;
	var awaiting = false;
	var scheduledTime = 0;
	var newDictionary = new Object;
	for (var cardName in cardDictionary) {
		var myCard = cardName;
		scheduledTime += 150;
		console.log(scheduledTime);
		delayedCardPrice(cardDictionary,cardName,scheduledTime,function(err,cardName,priceData) {
			newDictionary[cardName] = new Object;
			newDictionary[cardName].diffQuantity = cardDictionary[cardName];
			newDictionary[cardName].paperCents = priceData.paperCents;
			newDictionary[cardName].onlineCents = priceData.onlineCents;
			
			lockCount--;
			if (lockCount==0) {
				savePriceReport(newDictionary);
			}
		});
		
		
	}
}
function savePriceReport(cardDictionaryWithPrices) {
	var dictString = JSON.stringify(cardDictionaryWithPrices);
	var currentDateTime = new Date().toMysqlFormat();
	//save the data in the cache
	connection.query('INSERT INTO price_report (date, data) VALUES ?', [[[currentDateTime,dictString]]], function(err,result) {
		if (err) throw err;
		
		connection.end();
	});
}