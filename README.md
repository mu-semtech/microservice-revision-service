# Microservice Revision Service
Fetches images (revisions) from docker hub for all mu.semte.ch images in the triple store.

## Code Flow
This service will
  1. get all core microservices
     connect to the triple store and get all mu:Microservice objects
     that have a dct:title and are ext:isCoreMicroservice.
  2. get the first 100 revisions for every microservice
     For this we use a library called docker-hub-api. This library sports
     a function called tags(user, service, options). This function returns
     all tags for a given service
  3. store each found revision in the triple store

## set the revision fetching in motion
make a POST call on:
```
/update-revisions
```

## microservice model
The microservices are supposed to be stored in the db according to the following resources excerpt. The is-core property is supposed to be true.
```
(define-resource microservice ()
  :class (s-prefix "mu:Microservice")
  :properties `((:title :string ,(s-prefix "dct:title"))
                (:description :string ,(s-prefix "dct:description"))
                (:is-core :boolean ,(s-prefix "ext:isCoreMicroservice"))
                (:repository :url ,(s-prefix "ext:repository")))
  :has-many `((revision :via ,(s-prefix "ext:hasRevision")
                        :as "revisions"))
  :resource-base (s-url "http://info.mu.semte.ch/microservices/")
  :on-path "microservices")
```

## revision model
All revisions are stored as:
```
(define-resource revision ()
  :class (s-prefix "mu:MicroserviceRevision")
  :properties `((:image :string ,(s-prefix "ext:microserviceRevision"))
                (:version :string ,(s-prefix "ext:microserviceVersion")))
  :has-one `((microservice :via ,(s-prefix "ext:hasRevision")
                           :inverse t
                           :as "microservice"))
  :resource-base (s-url "http://info.mu.semte.ch/microservice-revisions/")
  :on-path "microservice-revisions")
```
