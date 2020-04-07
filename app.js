// This service will
//    1. get all core microservices
//       connect to the triple store and get all ext:Microservice objects
//       that have a dct:title and are ext:isCoreMicroservice.
//    2. get the first 100 revisions for every microservice
//       For this we use a library called docker-hub-api. This library sports
//       a function called tags(user, service, options). This function returns
//       all tags for a given service
//    3. store each found revision in the triple store

import { app, query, errorHandler, uuid } from 'mu';

// docker hub api is a library that let's me pull info of hub.docker.com easily
let dockerHubAPI = require('docker-hub-api');

// sync request will allow us to make synchronous requests while also supporting https
let request = require('sync-request');

// the mu semtech user that will be use in the tags(user, service, options) calls
const dockerHubUser = "semtech";

// Single entry point to this service.
// Will perform steps 1, 2 and 3
app.post('/update-revisions', function( req, res ) {
    var microserviceTitlesQuery = `
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?service ?title ?uuid ?repository ?gitRepository
    WHERE {
      GRAPH <http://mu.semte.ch/application> {
        ?service a ext:Microservice ;
              mu:uuid ?uuid ;
              dct:title ?title ;
              ext:repository ?repository ;
              ext:gitRepository ?gitRepository ;
              ext:isCoreMicroservice "true"^^xsd:boolean .
      }
    }`;

    query( microserviceTitlesQuery )
        .then( function(response) {
            const services = response["results"]["bindings"].map(function(responseObject) {
                return({
                    "service": responseObject["service"]["value"],
                    "title": responseObject["title"]["value"],
                    "uuid": responseObject["uuid"]["value"],
                    "repository": responseObject["repository"]["value"],
                    "gitRepository": responseObject["gitRepository"]["value"]
                });
            });
            updateRevisionsForServices(services);
            updateMetaInfoForServices(services);
            res.status(204).send();
        })
        .catch( function(err) {
            res.send( "Oops something went wrong: " + JSON.stringify( err ) );
        });
} );

// Step 2
// updateRevisionsForServices gets an array of 'service' objects
// that look like
// { "service": "http://example.com/services/123456789", "title": "exampleService" }
// and then calls the tags function on the dockerHubAPI for every one
// this tags function will connect to docker hub and read out the first 100 tags for
// that service.
// The tags function will return an array of 'tag' objects that look as follows
// { "name": "1.0.2", ... other info, see the docs ... }
// then we will loop over them and store each of these tags for that service
async function updateRevisionsForServices(services) {
    services.forEach(function(service, index) {
        dockerHubAPI.tags(
            dockerHubUser,
            service["title"], {
                'perPage': 100, // get at most 100 tags per page
                'page': 1 // we are only interested in the first 100 so page 1 will do
            }
        ).then(function(tags) {
            if(!Array.isArray(tags)) {
                tags = tags["results"]; // this is because the docker hub api method returns a wrapper around stuff it gets from it's cache
            }
            tags.forEach(function(tag, index) {
                storeRevisionInTripleStore(service, tag["name"]);
            });
        });
    });
};

// Step 3
// storeRevisionInTripleStore expects a service object and a revision name
// the service object will look like:
// { "service": "http://example.com/services/123456789", "title": "exampleService" }
// and the revision name could be something like "1.2.3"
// this service will 3.1. 'build' a revision object
//                   3.2. insert a triple form of that object in the triple store
//                   3.3. insert a single triple that connects the service to the triple form
async function storeRevisionInTripleStore(service, revision) {
    let revisionObject = await buildRevisionObject(service, revision);
    query ( getRevisionInsertQuery(revisionObject) );
    query ( getServiceRevisionLinkInsertQuery(service, revisionObject) );
}

async function buildRevisionObject(service, revision) {
    return({
        "id": await calculateUUIDForRevision(service, revision),
        "version": revision,
        "image": dockerHubUser + "/" + service["title"]
    });
}

function getRevisionInsertQuery(revision) {
    let query =  `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/application> {
        <http://info.mu.semte.ch/microservice-revisions/${revision["id"]}> a ext:MicroserviceRevision ;
              mu:uuid "${revision["id"]}" ;
              ext:microserviceRevision "${revision["image"]}" ;
              ext:microserviceVersion "${revision["version"]}" .
      }
    }`;
    return query;
}

function getServiceRevisionLinkInsertQuery(service, revision) {
    let query =  `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/application> {
        <${service["service"]}> ext:hasRevision <http://info.mu.semte.ch/microservice-revisions/${revision["id"]}> .
      }
    }`;
    return query;
}

// calculateUUIDForRevision has some logic to make sure that if we already have a certain
// revision for a certain service that we then return that service's UUID instead of generating
// a new one. By doing this we can assume it safe to just insert all revisions in the triple store
// every time instead of figuring out which ones were there already and then inserting those.
function calculateUUIDForRevision(service, revision) {
    return getRevisionUUIDFromTripleStore(service, revision)
        .then(function(revisionUUID) {
            if(revisionUUID === undefined) {
                return uuid();
            }
            return revisionUUID;
        });
}

async function getRevisionUUIDFromTripleStore(service, revision) {
    let uuidQuery = `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    SELECT ?uuid
    WHERE {
      GRAPH <http://mu.semte.ch/application> {
        ?revision a ext:MicroserviceRevision ;
              mu:uuid ?uuid ;
              ext:microserviceRevision "${dockerHubUser}/${service["title"]}" ;
              ext:microserviceVersion "${revision}" .
      }
    }`;
    let results = await query( uuidQuery );

    if(results["results"]["bindings"].length > 0) {
        return results["results"]["bindings"][0]["uuid"]["value"];
    }
    return undefined;
}

// META PART
// TODO: document...
async function updateMetaInfoForServices(services) {
    services.forEach(function(service, index) {
        deleteMetaInfoForService(service);
        service = augmentServiceWithMetaInfo(service);
        updateMetaInfoForService(service);
    });
};

async function deleteMetaInfoForService(service) {
    let deleteQuery = `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    DELETE {
      GRAPH <http://mu.semte.ch/application> {
       ?service ext:composeSnippet ?composeSnippet;
                ext:creationSnippet ?creationSnippet;
                ext:developmentSnippet ?developmentSnippet .
      }
    }
    WHERE {
      GRAPH <http://mu.semte.ch/application> {
        ?service a ext:Microservice ;
              mu:uuid "${service["uuid"]}" ;
              ext:composeSnippet ?composeSnippet;
              ext:creationSnippet ?creationSnippet;
              ext:developmentSnippet ?developmentSnippet .
      }
    }`;
    await query( deleteQuery );
}

async function updateMetaInfoForService(service) {
    let insertQuery = `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/application> {
          <${cmd["service"]} ext:composeSnippet "${service["composeSnippet"]}" ;
                ext:creationSnippet "${service["creationSnippet"]}" ;
                ext:developmentSnippet "${service["developmentSnippet"]}" .
      }
    }`;
    await query( insertQuery );

    let deleteCommandsQuery = `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    DELETE {
      GRAPH <http://mu.semte.ch/application> {
       ?service ext:hasCommand ?command .
       ?command ?p ?o .
      }
    }
    WHERE {
      GRAPH <http://mu.semte.ch/application> {
        ?service a ext:Microservice ;
              mu:uuid "${service["uuid"]}" ;
              ext:hasCommand ?command .
      }
    }`;
    await query( deleteCommandsQuery );

    for(let commandIndex in service["commands"])
    {
        let cmd = service["commands"][commandIndex];
        let commandUUID = uuid();
        let insertCommandQuery = `
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX dct: <http://purl.org/dc/terms/>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/application> {
          <${cmd["service"]} ext:hasCommand <http://info.mu.semte.ch/microservice-commands/${commandUUID}> .
          <http://info.mu.semte.ch/microservice-commands/${commandUUID}> a ext:MicroserviceCommand;
                mu:uuid "${commandUUID}" ;
                ext:commandTitle "${cmd["title"]}" ;
                ext:shellCommand "${cmd["shellCommand"]}" ;
                dct:description "${cmd["description"]}" .
      }
    }`;
        await query( insertCommandQuery );
    }

}

function escape(text)
{
    return text.trim().split("\n").join("\\n").split("\"").join("\\\"");
}

function commandArrayFromCommandText(service, commandText)
{
    let commands = [];
    commandText = commandText.trim();
    if(commandText.length <= 0) {
        return commands;
    }
    let lines = commandText.split("\n");
    for(let lineIndex in lines) {
        let commandParts = lines[lineIndex].split(",");
        commands.push({
            "title": escape(commandParts[0]),
            "shellCommand": escape(commandParts[1]),
            "description": escape(commandParts[2]),
            "service": service["service"]
        });
    }
    return commands;
}

function augmentServiceWithMetaInfo(service) {
    const baseUrl = service["gitRepository"].replace("https://github.com/", "https://raw.githubusercontent.com/");
    const commandsUrl = baseUrl + "/wip/commands";
    const composeSnippetUrl = baseUrl + "/wip/compose-snippet";
    const creationSnippetUrl = baseUrl + "/wip/creation-snippet";
    const developmentSnippetUrl = baseUrl + "/wip/development-snippet";

    service["commands"] = commandArrayFromCommandText(service, makeHTTPRequestOrUseDefault(commandsUrl, ""));
    service["composeSnippet"] = escape(makeHTTPRequestOrUseDefault(composeSnippetUrl, defaultDockerComposeSnippet()));
    service["creationSnippet"] = escape(makeHTTPRequestOrUseDefault(creationSnippetUrl, defaultCreationSnippet()));
    service["developmentSnippet"] = escape(makeHTTPRequestOrUseDefault(developmentSnippetUrl, defaultDevelopmentSnippet()));

    console.log(service);
    return service;
}

function makeHTTPRequestOrUseDefault(url, defaultResponse) {
    try {
        var res = request('GET', url);
        return res.getBody().toString();
    } catch (error) {
        return defaultResponse;
    }
}

function defaultDockerComposeSnippet() {
    return 'image: semtech/mu-javascript-template:1.3.5 \nlinks: \n  - db:database \nports: \n  - \"8888:80\" \n  - \"9229:9229\" \nenvironment: \n  NODE_ENV: \"development\" \nvolumes: \n  - \"/tmp/tmp/test-js/:/app\"';
}

function defaultCreationSnippet() {
    return 'image: semtech/mu-javascript-template:1.3.5 \nlinks: \n  - db:database \nports: \n  - \"8888:80\" \n  - \"9229:9229\" \nenvironment: \n  NODE_ENV: \"development\" \nvolumes: \n  - \"/tmp/tmp/test-js/:/app\"';
}

function defaultDevelopmentSnippet() {
    return 'image: semtech/mu-javascript-template:1.3.5 \nlinks: \n  - db:database \nports: \n  - \"8888:80\" \n  - \"9229:9229\" \nenvironment: \n  NODE_ENV: \"development\" \nvolumes: \n  - \"/tmp/tmp/test-js/:/app\"';
}

app.use(errorHandler);
