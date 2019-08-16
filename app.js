// This service will
//    1. get all core microservices
//       connect to the triple store and get all mu:Microservice objects
//       that have a dct:title and are ext:isCoreMicroservice.
//    2. get the first 100 revisions for every microservice
//       For this we use a library called docker-hub-api. This library sports
//       a function called tags(user, service, options). This function returns
//       all tags for a given service
//    3. store each found revision in the triple store

import { app, query, errorHandler, uuid } from 'mu';

// docker hub api is a library that let's me pull info of hub.docker.com easily
let dockerHubAPI = require('docker-hub-api');

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
    SELECT ?service ?title
    WHERE {
      GRAPH <http://mu.semte.ch/application> {
        ?service a mu:Microservice ;
              dct:title ?title ;
              ext:isCoreMicroservice "true"^^xsd:boolean .
      }
    }`;

    query( microserviceTitlesQuery )
        .then( function(response) {
            const services = response["results"]["bindings"].map(function(responseObject) {
                return({
                    "service": responseObject["service"]["value"],
                    "title": responseObject["title"]["value"]
                });
            });
            updateRevisionsForServices(services);
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
        <http://info.mu.semte.ch/microservice-revisions/${revision["id"]}> a mu:MicroserviceRevision ;
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
        ?revision a mu:MicroserviceRevision ;
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

app.use(errorHandler);
