// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, query, errorHandler, uuid } from 'mu';

// docker hub api is a library that let's me pull info of hub.docker.com easily
let dockerHubAPI = require('docker-hub-api');

const dockerHubUser = "semtech";

app.get('/update-revisions', function( req, res ) {
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

function calculateUUIDForRevision(service, revision) {
    return getRevisionUUIDFromTripleStore(service, revision)
        .then(function(revisionUUID) {
            if(revisionUUID === undefined) {
                return uuid();
            }
            return revisionUUID;
        });
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

async function storeRevisionInTripleStore(service, revision) {
    let revisionObject = await buildRevisionObject(service, revision);
    // insert the revision in the database
    query ( getRevisionInsertQuery(revisionObject) );
    // then insert the linke to the service in the database
    query ( getServiceRevisionLinkInsertQuery(service, revisionObject) );
}

app.use(errorHandler);
