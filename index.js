"use strict"

var version = 'unknown';

var fs = require('fs');
var http = require('http');
var https = require('https');
var path = require('path');
var Q = require('q');
var unzip = require('unzip2');
var yaml = require('yaml-js');

var SNAPSHOT_REPO = "https://oss.sonatype.org/content/repositories/snapshots/";
var RELEASE_REPO = "https://repo.maven.apache.org/maven2";

const extractZipEntry = (zipPath, entryPath)=>{
 var deferred = Q.defer();
 var found = false;
 try {
   fs.createReadStream(zipPath)
     .pipe(unzip.Parse())
     .on('entry', function (entry) {
       var fileName = entry.path;
       var type = entry.type; // 'Directory' or 'File'
       var size = entry.size;
       if (fileName === entryPath ) {
         found = true;
         deferred.resolve( entry );
       } else {
         entry.autodrain();
       }
     })
     .on('close', ()=>{
       if ( ! found ) {
         deferred.resolve();
       }
     })
     .on('error', (err)=>{
       deferred.resolve();
     });
 } catch (err) {
   deferred.resolve();
 }
 return deferred.promise;
}

const readEntry = (entry)=>{
  var deferred = Q.defer();
  var body = "";
  entry.on('data', (chunk)=>{
    body += chunk;
  })

  entry.on('end', ()=>{
    deferred.resolve(body);
  })
  return deferred.promise;
}

const parseDocs = (docs)=>{
  var bits = [];
  docs.split('\n').forEach( (line)=>{
    var parts = line.split("=");
    var key = parts[0];
    var doc = parts[1];
    if ( ! key.startsWith('#') && key != 'fraction' && doc ) {
      bits.push( { key: key, doc: doc } );
    }
  });

  bits.sort( (l,r)=>{
    return l.key.localeCompare(r.key);
  });

  return bits;
}

const generateConfigurableDocsFragment = (docs)=>{
  var content = "";
  docs.forEach( (entry)=>{
    var key = entry.key.replace( /\*/g, '_KEY_');
    content += (key + ":: " + entry.doc + "\n");
  });
  return content;
}

const generateCoordinatesFragment = (groupId,artifactId)=>{
  var content = ""
  content += "[source,xml]\n";
  content += "----\n";
  content += "<dependency>\n";
  content += "  <groupId>" + groupId + "</groupId>\n";
  content += "  <artifactId>" + artifactId + "</artifactId>\n";
  content += "</dependency>\n";
  content += "----\n";
  return content;
}

const parseFractionManifest = (txt)=>{
  var manifest = yaml.load(txt);
  return manifest;
}

const generateDocs = (book, page)=>{
  console.log("Processing: ", page.title, page.groupId, page.artifactId);
  var groupId = 'org.wildfly.swarm';
  if ( page.groupId ) {
    groupId = page.groupId;
  }
  var artifactId = path.basename( page.path, '.adoc' );
  if ( page.artifactId ) {
    artifactId = page.artifactId;
  }

  return locateArtifact(groupId, artifactId, "jar")
    .then( (path)=>{
      return Q.all( [
        extractZipEntry(path, "META-INF/configuration-meta.properties")
          .then( (entry)=>{
            if ( ! entry ) { return ""; }
            return readEntry(entry)
              .then( (txt)=>{
                return generateConfigurableDocsFragment( parseDocs( txt ) );
              })
          }),
        extractZipEntry(path, "META-INF/README.adoc")
          .then( (entry)=>{
            if ( ! entry ) { return ""; }
            return readEntry(entry);
          }),
        generateCoordinatesFragment(groupId, artifactId),
        extractZipEntry(path, "META-INF/fraction-manifest.yaml")
          .then( (entry)=>{
            if ( ! entry ) { return {}; }
            return readEntry(entry)
              .then( (txt)=>{
                return parseFractionManifest( txt );
              })
          })
      ])
    })
    .then( (values)=>{
      page.content += "\n";
/*
      if ( values[1] ) {
        page.content += values[1];
      } else {
        page.content += "# " + page.title;
      }
      if ( values[3].stability && values[3].stability.level ) {
        page.content += "\n\n";
        page.content += "image::http://badges.github.io/stability-badges/dist/" + values[3].stability.level.toLowerCase() + ".svg[" + values[3].stability.level + "]";
      }
*/
      page.content += pageHeader(page, values[1], values[3] );
      page.content += "\n\n";
      page.content += "## Coordinates\n\n";
      page.content += values[2];
      page.content += "\n\n";
      page.content += "## Configuration\n\n";
      if ( values[0] == "" ) {
        page.content += "This fraction has no configuration.";
      } else {
        page.content += values[0];
      }
    })
    .then( ()=>{
      return page;
    })
    .catch( (err)=>{
      console.log("problem", page.title, err );
      return page;
    });

}

const pageHeader = (page, readme, manifest)=>{
  var header = "";
  var restOfReadme = "";

  readme = readme.trim();

  if ( ! readme ) {
    header += "# " + page.title + "\n";
  } else {
    var results = new RegExp( "^(# [^\\n]*)\\n(.*)" ).exec(readme);
    // console.log( "results", results );
    if ( results ) {
      header += results[1];
      restOfReadme = readme.substring( results[1].length );
    } else {
      header += "# " + page.title + "\n";
      restOfReadme = readme;
    }
  }

  header += "\n\n";
  if ( manifest.stability && manifest.stability.level ) {
    header += "image::http://badges.github.io/stability-badges/dist/" + manifest.stability.level.toLowerCase() + ".svg[" + manifest.stability.level + "]";
  } else {
    header += "image::http://badges.github.io/stability-badges/dist/unstable.svg[UNSTABLE]";
  }

  header += restOfReadme;

  return header;
}

const locateArtifact = (groupId, artifactId, ext)=>{
  var path = groupId.replace(/\./g, '/') + '/' + artifactId + '/' + version + '/' + artifactId + '-' + version + '.' + ext;
  return locateArtifactInLocalRepo(path)
    .then( (artifact)=>{
      if ( ! artifact ) {
        return locateArtifactInRemoteRepo(path);
      }
      return artifact;
    });
}

const locateArtifactInLocalRepo = (path)=>{
  var localPath = process.env.HOME + '/.m2/repository/' + path;
  if ( fs.existsSync( localPath ) ) {
    return Q.resolve(localPath);
  }

  return Q.resolve(undefined);

}

const locateArtifactInRemoteRepo = (path)=>{
  if ( path.includes('SNAPSHOT')) {
    return determineSnapshotPath(SNAPSHOT_REPO,path)
      .then( (mavenPath)=>{
        return fetchArtifact( SNAPSHOT_REPO, mavenPath );
      } );
  }

  return fetchArtifact( RELEASE_REPO, path );
}

const determineSnapshotPath = (repo,mavenPath)=>{
  return fetchMavenMetadata(repo,mavenPath)
    .then( (content)=>{
      var results = new RegExp("<timestamp>([0-9.]+)</timestamp>").exec( content );
      var tstamp = results[1];
      results = new RegExp("<buildNumber>([0-9]+)</buildNumber>").exec( content );
      var buildNumber = results[1];
      var dirname = path.dirname( mavenPath );
      var filename = path.basename( mavenPath );
      return dirname + '/' + filename.replace('SNAPSHOT', tstamp + '-' + buildNumber );
    })
}

const fetchMavenMetadata = (repo,mavenPath)=>{
  var dir = path.dirname(mavenPath);
  var metadata = dir + '/maven-metadata.xml';

  var deferred = Q.defer();

  var url = repo + '/' + metadata;

  var getter = http;
  if ( url.startsWith('https')) {
    getter = https;
  }

  var request = getter.get(url, function(response) {
    var body = "";
    response.on('data', (chunk)=>{
      body += chunk;
    })
    response.on('end', ()=>{
      deferred.resolve(body);
    })
  });

  return deferred.promise;
}

const fetchArtifact = (repo, mavenPath)=>{
  if ( ! fs.existsSync( "_tmp" ) ) {
    fs.mkdirSync( "_tmp" );
  }

  var url = repo + '/' + mavenPath;

  var deferred = Q.defer();

  var filename = path.basename(mavenPath);

  var outpath = "_tmp/" + filename;
  var file = fs.createWriteStream(outpath);
  var request = https.get(url, function(response) {
    response.pipe(file);
    file.on('finish', ()=>{
      deferred.resolve(outpath);
    } );
  });

  return deferred.promise;
}

const setVersion = (v)=>{
  version = v;
}

module.exports = {
  setVersion: setVersion,
  locateArtifact: locateArtifact,
  hooks: {
    'init': function() {
      //version = this.config.values.variables.versions.swarm;
      setVersion(this.config.values.variables.versions.swarm);
    },
    'page:before': function(page) {
      if ( ! page.path.startsWith('fractions/')) {
        console.log( "verbatim", page.path );
        return page;
      }
      return generateDocs(this, page);
    }
  }
}

