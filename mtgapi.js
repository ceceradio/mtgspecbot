var request = require("request");

var token = "";
var rateLimit = 300;
var currentRate = 0;
exports.setToken = function (tokenArg) {
	token = tokenArg;
}
exports.searchByName = function (cardName,callback) {
	console.log("http://mtgapi.com/api/v1/fetch/search/"+encodeURI(cardName.split("/")[0])+"?token="+token);
	
	setTimeout(function () {
		request("http://mtgapi.com/api/v1/fetch/search/"+encodeURI(cardName.split("/")[0])+"?token="+token, function(error, response, body) {
			if (error) throw error;
			if (response.statusCode == 404) {
				var err = "404";
				callback(err, null);
				return;
			}
			try {
				var results = JSON.parse(body);
			}
			catch (exp) {
				var err = "API Error ";
				callback(err, null);
				return;
			}
			if (results.length<=0) {
				var err = "Card not found";
				callback(err, null);
				return;
			}
			else {
				for (var i in results[0]) {
					if (cardName.replace(/[\W\s]+/gi,"") == results[0][i].name.replace(/[\W\s]+/gi,"")) {
						console.log(results[0][i].set);
						callback(error, results[0][i]);
						return;
					}
				}
				console.log(results[0][0].set);
				callback(error, results[0][0]);
			}
		});
	},currentRate);
	currentRate+=rateLimit;
}